import { clipboard, type IpcMain, type WebContents } from 'electron'
import { IPC, type DictationRecordEvent, type DictationTranscribeResult } from '../shared/ipc'
import { resolveKey } from './keystore'
import { getSettings, recordTake } from './store'
import { setTrayRecording } from './tray'
import { flashPillError, hidePill, initPill, pillLevels, showPill } from './pill'

/**
 * whisp's core — system-wide dictation.
 *
 * Hold Ctrl+Win anywhere in Windows, speak, release: the transcript is pasted
 * into whatever control has OS focus. Never submitted — the paste is the
 * whole gesture; pressing Enter stays the human's job.
 *
 * Main owns the flow because only main can see beyond whisp's own windows:
 * the hotkey (a GetAsyncKeyState poll — a modifier-only hold is inexpressible
 * in globalShortcut, which has no keyup at all), the OpenAI call (the API key
 * never leaves main), the injection (clipboard + a synthesized Ctrl+V via
 * SendInput) and the pill (pill.ts). The hidden capture window contributes
 * exactly one thing: the microphone, since getUserMedia lives there.
 *
 * Takes overlap on purpose: releasing the combo starts a transcription, and
 * holding again immediately starts the next take while the last one is still
 * in flight — dictating consecutive thoughts must not wait on the network.
 * Each take carries an id minted here and echoed back with its audio, so a
 * late or abandoned answer can't be mistaken for a newer take's; injections
 * are serialized so two finishing close together can't interleave their
 * clipboard dances.
 */

/** Both Win keys count — Wispr's gesture, kept muscle-memory compatible. */
const VK_CONTROL = 0x11
const VK_LWIN = 0x5b
const VK_RWIN = 0x5c
const VK_V = 0x56
const KEYEVENTF_KEYUP = 0x0002

/** 50ms: fast enough that no deliberate press or release falls between polls. */
const POLL_MS = 50

/**
 * Vocabulary bias for the transcriber, from the Dictionary tab. A prompt,
 * not an instruction channel: transcribe models take a style/spelling hint
 * and nothing more.
 */
function vocabPrompt(): string {
  return getSettings().dictionary.join(', ')
}

/**
 * Transcription models fed (near-)silence hand the vocabulary prompt back
 * verbatim as their "transcript" — dictating nothing would paste the jargon
 * list. The capture window's silence gate stops most of that audio from ever
 * uploading; this is the backstop for what slips through (breath, a bumped
 * mic). Deliberately an exact match after normalization: a real dictation
 * that merely contains a dictionary word must never be eaten.
 */
function isPromptEcho(text: string, prompt: string): boolean {
  if (!prompt) return false
  const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim()
  return fold(text) === fold(prompt)
}

interface User32 {
  GetAsyncKeyState: (vk: number) => number
  SendInput: (count: number, inputs: unknown[], size: number) => number
  inputSize: number
  keyEvent: (vk: number, flags: number) => Record<string, unknown>
}

/**
 * The FFI surface, loaded lazily so a machine where koffi fails to load gets
 * a logged, dictation-less boot instead of a crashed one. koffi ships N-API
 * prebuilds (no toolchain, no electron-rebuild); `npm run smoke:ffi` is the
 * regression guard.
 */
function loadUser32(): User32 | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const lib = koffi.load('user32.dll')

    // KEYBDINPUT nested in INPUT, padded to match C's sizeof(INPUT) == 40 on
    // x64 (the union's largest member is MOUSEINPUT): SendInput validates
    // cbSize and silently types nothing if it disagrees.
    const KEYBDINPUT = koffi.struct('WHISP_KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uint64'
    })
    const INPUT = koffi.struct('WHISP_INPUT', {
      type: 'uint32',
      _pad0: 'uint32',
      ki: KEYBDINPUT,
      _pad1: 'uint64'
    })

    const GetAsyncKeyState = lib.func('int16 __stdcall GetAsyncKeyState(int vKey)')
    const SendInput = lib.func('uint __stdcall SendInput(uint cInputs, WHISP_INPUT *pInputs, int cbSize)')
    const inputSize = koffi.sizeof(INPUT)

    return {
      GetAsyncKeyState: (vk) => GetAsyncKeyState(vk) as number,
      SendInput: (count, inputs, size) => SendInput(count, inputs, size) as number,
      inputSize,
      keyEvent: (vk, flags) => ({
        type: 1, // INPUT_KEYBOARD
        _pad0: 0,
        ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        _pad1: 0
      })
    }
  } catch (err) {
    console.error('whisp: koffi/user32 unavailable, dictation disabled:', err)
    return null
  }
}

let user32: User32 | null = null
let renderer: WebContents | null = null
let pollTimer: NodeJS.Timeout | null = null

/** True while the combo is physically held — the recording state. */
let holding = false
/**
 * Muted: the poll keeps running but the start edge is ignored. Exists for
 * the two-owner case — the hotkey is a GetAsyncKeyState poll, not an
 * exclusive registration, so two dictation hosts BOTH fire on the same press
 * (two recordings, two pastes). Session-only on purpose: a restart unmutes,
 * so a muted whisp can't silently stay deaf for a week.
 */
let muted = false

export function dictationMuted(): boolean {
  return muted
}

/** A mute landing mid-hold lets the running take finish — only new starts are blocked. */
export function setDictationMuted(next: boolean): void {
  muted = next
}
/** Take ids, minted per hold. */
let takeCounter = 0
/**
 * Takes whose audio is still owed or in transcription, keyed by id, valued
 * by their watchdog: if the capture window never answers (a dev-server
 * reload mid-take), the watchdog forgets the take so its late answer —
 * should one still come — is recognized as stale and dropped.
 */
const inFlight = new Map<number, NodeJS.Timeout>()
/**
 * Injection is ordered by SPEECH, not by network: take ids ascend per hold,
 * `owedOrder` remembers that order, and a take that resolved out of turn
 * (its REST call was simply faster) parks in `resolvedText` until every
 * earlier take has resolved too. Every take settles exactly once — with its
 * transcript, or with '' on error/timeout/silence — so one lost take can
 * never dam the queue. flushInjects walks the front of the queue serially,
 * which also keeps two clipboard dances from interleaving.
 */
const owedOrder: number[] = []
const resolvedText = new Map<number, string>()
let flushing = false

function down(vk: number): boolean {
  return user32 !== null && (user32.GetAsyncKeyState(vk) & 0x8000) !== 0
}

/**
 * One place derives all UI from the two facts that exist: holding, and how
 * many takes are still in flight. Recording wins the pill (you're speaking
 * now); otherwise pending work shows as transcribing; otherwise nothing.
 */
function refreshUi(): void {
  setTrayRecording(holding)
  if (holding) showPill('recording')
  else if (inFlight.size > 0) showPill('transcribing')
  else hidePill()
}

function sendRecord(event: DictationRecordEvent): void {
  renderer?.send(IPC.dictationRecord, event)
}

function pollHotkey(): void {
  const combo = down(VK_CONTROL) && (down(VK_LWIN) || down(VK_RWIN))
  if (combo && !holding && muted) return
  if (combo && !holding) {
    // Hold began: record until release. A Win+Ctrl+Arrow desktop switch
    // passes through here too — its sub-second take is discarded by the
    // too-short guard in onAudio, at the cost of a blink of the pill.
    holding = true
    takeCounter++
    sendRecord({ action: 'start', take: takeCounter, chime: getSettings().chime })
    refreshUi()
  } else if (!combo && holding) {
    // Release: this take's audio is now owed; transcription happens when it
    // arrives. Holding again immediately starts the next take in parallel.
    holding = false
    const take = takeCounter
    const watchdog = setTimeout(() => {
      if (!inFlight.has(take)) return
      settleTake(take, '')
      pillError('the recorder never answered')
    }, 20_000)
    inFlight.set(take, watchdog)
    owedOrder.push(take)
    sendRecord({ action: 'stop', take })
    refreshUi()
  }
}

/**
 * Waits for the physical hotkey to be released before pasting — normally
 * instant (releasing it is what ended the take), but a re-hold for the next
 * take can be underway, and synthesizing V into held modifiers would send
 * Ctrl+Win+V (Windows' clipboard-history popup) instead of Ctrl+V.
 *
 * A legitimate hold waits it out with no deadline at all: a take resolving
 * while the next one is being spoken must paste after the release, not throw
 * its transcript away because someone talked for more than two seconds. The
 * timeout only measures keys held *outside* a hold — a stuck or gamer-pinned
 * key — and aborts then, since that chord would never clear.
 */
async function modifiersReleased(): Promise<boolean> {
  let quietSince = Date.now()
  for (;;) {
    if (!down(VK_CONTROL) && !down(VK_LWIN) && !down(VK_RWIN)) return true
    if (holding) quietSince = Date.now()
    else if (Date.now() - quietSince > 2000) return false
    await new Promise((r) => setTimeout(r, 25))
  }
}

/**
 * Clipboard-carried paste, the injection route that handles any length: set
 * the transcript, type Ctrl+V into the OS-focused control, put the previous
 * clipboard back. Text only — an image on the clipboard is lost to a
 * dictation, which is the accepted cost of not owning a full-format snapshot.
 */
async function inject(text: string): Promise<void> {
  if (!user32) throw new Error('text injection unavailable (koffi failed to load)')
  if (!(await modifiersReleased())) {
    throw new Error('the hotkey never released — nothing pasted')
  }
  // Snapshot as late as possible, so a copy made during the release wait
  // isn't the thing that gets clobbered.
  const previous = clipboard.readText()
  clipboard.writeText(text)
  const events = [
    user32.keyEvent(VK_CONTROL, 0),
    user32.keyEvent(VK_V, 0),
    user32.keyEvent(VK_V, KEYEVENTF_KEYUP),
    user32.keyEvent(VK_CONTROL, KEYEVENTF_KEYUP)
  ]
  const typed = user32.SendInput(events.length, events, user32.inputSize)
  if (typed !== events.length) {
    // Partial success can strand synthetic keys down — release them before
    // anything else, or the whole session types with a phantom Ctrl held.
    user32.SendInput(
      2,
      [user32.keyEvent(VK_V, KEYEVENTF_KEYUP), user32.keyEvent(VK_CONTROL, KEYEVENTF_KEYUP)],
      user32.inputSize
    )
    clipboard.writeText(previous)
    throw new Error('SendInput refused the paste (elevated window in focus?)')
  }
  // The target reads the clipboard on its own schedule; restore after it
  // plausibly has (500ms has margin over anything observed) — but only if the
  // clipboard still holds our transcript. A copy the human made in that
  // window beats the restore; overwriting it with the stale snapshot would
  // turn a paste convenience into data loss.
  await new Promise((r) => setTimeout(r, 500))
  if (clipboard.readText() === text) clipboard.writeText(previous)
}

/**
 * An error with nowhere else to go. The pill is dictation's whole in-flow
 * UI, but a live recording outranks a stale grievance: while the human is
 * holding for a newer take, the pill keeps saying Listening (matching the
 * tray) and the old take's error — which already means "nothing will paste"
 * — goes unshown.
 */
function pillError(message: string): void {
  if (holding) return
  flashPillError(message, refreshUi)
}

/**
 * One take's final word, whatever the path — transcript, silence, error,
 * timeout: leave the in-flight set, park the text for ordered injection,
 * and let the queue advance.
 */
function settleTake(take: number, text: string): void {
  const watchdog = inFlight.get(take)
  if (watchdog !== undefined) clearTimeout(watchdog)
  inFlight.delete(take)
  resolvedText.set(take, text)
  refreshUi()
  void flushInjects()
}

/** Pastes every take whose turn has come, in speech order, one at a time. */
async function flushInjects(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    while (owedOrder.length > 0 && resolvedText.has(owedOrder[0])) {
      const take = owedOrder.shift()!
      const text = resolvedText.get(take)!
      resolvedText.delete(take)
      if (!text) continue
      try {
        await inject(text)
      } catch (err) {
        // This take's paste failed; the ones behind it still get their turn.
        pillError(err instanceof Error ? err.message : String(err))
      }
    }
  } finally {
    flushing = false
  }
}

/**
 * One take, transcribed over REST. Streaming buys nothing here — the paste
 * happens once, at the end — and a plain upload has no session lifecycle, no
 * VAD tuning, and no handshake eating the first words: recording starts the
 * instant the hotkey fires.
 */
async function transcribe(audio: Uint8Array, mime: string): Promise<string> {
  const key = await resolveKey()
  if (!key) throw new Error('no API key — open Settings from the whisp tray icon')

  const prompt = vocabPrompt()
  const { model, languages } = getSettings()
  const form = new FormData()
  const ext = mime.includes('ogg') ? 'ogg' : 'webm'
  form.append('file', new Blob([Buffer.from(audio)], { type: mime }), `dictation.${ext}`)
  form.append('model', model)
  if (prompt) form.append('prompt', prompt)
  // The spoken-languages hint from Settings — a few seconds of a short take
  // gives free detection little to go on, and Norwegian misheard as Swedish
  // pastes garbage. gpt-transcribe takes the whole set (repeated `languages[]`
  // fields, OpenAI's multipart array convention) and detects within it; the
  // mini model's API fits a single code, so it's hinted only when exactly one
  // language is selected and detects freely otherwise.
  if (model === 'gpt-transcribe') {
    for (const code of languages) form.append('languages[]', code)
  } else if (languages.length === 1) {
    form.append('language', languages[0])
  }
  form.append('response_format', 'json')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    // A hung upload must not strand the take; 30s covers any take worth
    // transcribing with margin.
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body) => (body as { error?: { message?: string } }).error?.message)
      .catch(() => undefined)
    throw new Error(detail ?? `OpenAI refused the transcription (HTTP ${res.status}).`)
  }
  const { text } = (await res.json()) as { text?: string }
  const trimmed = (text ?? '').trim()
  return isPromptEcho(trimmed, prompt) ? '' : trimmed
}

/**
 * The Wispr-parity seam, deliberately a no-op for now: filler-word removal
 * and "scratch that" become one chat completion ("clean this dictation,
 * keep the meaning") — same key resolution, same latency budget, and the
 * caller doesn't change.
 */
async function cleanupTranscript(text: string): Promise<string> {
  return text
}

async function onAudio(
  audio: Uint8Array,
  mime: string,
  take: number,
  seconds: number
): Promise<DictationTranscribeResult> {
  // Not a take we're waiting for: it outlived its watchdog, or was never
  // asked for. Touch nothing — newer takes may be mid-flight, and stale text
  // pasted into wherever focus is now would be wrong even if they weren't.
  if (!inFlight.has(take)) {
    return { ok: false, error: 'stale take — already timed out' }
  }

  try {
    // Sub-half-second of opus is a misfire (a tapped combo, a desktop
    // switch), not speech — don't spend a request learning it transcribes
    // to nothing. The injection itself is not awaited here: its turn in the
    // speech-ordered queue may be behind takes still transcribing; a paste
    // failure surfaces on the pill.
    const text =
      audio.byteLength < 2000 ? '' : await cleanupTranscript(await transcribe(audio, mime))
    settleTake(take, text)
    // The bookkeeping: history and stats.
    if (text) recordTake(text, Number.isFinite(seconds) && seconds > 0 ? seconds : 0)
    return { ok: true, text }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    settleTake(take, '')
    pillError(error)
    return { ok: false, error }
  }
}

export function initDictation(ipcMain: IpcMain, webContents: WebContents): void {
  renderer = webContents
  if (pollTimer) return // re-init on the same instance: keep one poll

  user32 = loadUser32()
  if (!user32) return
  initPill()

  ipcMain.handle(
    IPC.dictationTranscribe,
    (
      _e,
      audio: Uint8Array,
      mime: string,
      take: number,
      seconds: number
    ): Promise<DictationTranscribeResult> => onAudio(audio, mime, take, seconds)
  )
  // The capture window's mic can fail (denied, unplugged) with nothing else
  // to show for it — the pill is dictation's only in-flow UI, so the error
  // surfaces there.
  ipcMain.on(IPC.dictationMicError, (_e, message: string) => {
    pillError(message || 'microphone unavailable')
  })
  // The pill's wave: mic band levels from the capture window's analyser,
  // forwarded only while the hold is actually up — a straggler frame from a
  // take that just ended must not twitch a pill that has moved on.
  ipcMain.on(IPC.dictationLevel, (_e, bands: number[]) => {
    if (holding && Array.isArray(bands)) pillLevels(bands)
  })
  pollTimer = setInterval(pollHotkey, POLL_MS)
  pollTimer.unref()
}

export function stopDictation(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  renderer = null
  for (const watchdog of inFlight.values()) clearTimeout(watchdog)
  inFlight.clear()
  owedOrder.length = 0
  resolvedText.clear()
}
