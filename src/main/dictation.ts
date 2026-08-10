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
 * Double-tap the same combo and the take latches: whisp keeps listening with
 * nothing held down, so the hands (and the eyes) are free to go read
 * something else mid-sentence. One more tap ends it, and the transcript goes
 * wherever focus is at that moment — so the discipline is "come back to the
 * input before you tap", and the reward is dictating while you browse.
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
 * The double-tap that latches a take into a hands-free session, in the only
 * terms the poll can see: a press shorter than TAP_MAX_MS is too brief to be
 * speech, so it might be half a gesture; a second press within
 * DOUBLE_TAP_MS of its release completes one.
 *
 * The consequence is that a lone short tap can't be finalized the instant it
 * releases — the mic stays open for the rest of the window in case the second
 * tap lands. It costs nothing: audio that short is discarded by the length
 * guard or the capture window's silence gate either way, and keeping it
 * rolling is what makes a latched session lose no words at its start.
 */
const TAP_MAX_MS = 300
const DOUBLE_TAP_MS = 400
/**
 * Windows' own Ctrl+Win chords: virtual-desktop switching (arrows), new
 * desktop (D), close desktop (F4). Each reaches the poll looking exactly like
 * a tap, and two desktop switches in a row would otherwise latch a hands-free
 * session while the human was only changing desktops. A hold that contained
 * one of these can still be a take — it can never be half a gesture.
 */
const CHORD_KEYS = [0x25, 0x26, 0x27, 0x28, 0x44, 0x73]
/**
 * A hands-free session survives no keys being held, which also means nothing
 * physical reminds you it's running — a forgotten one would record until the
 * app quit. At the cap it stops the way a tap would: transcribed, pasted,
 * nothing lost, with the pill saying why.
 */
const HANDS_FREE_MAX_MS = 5 * 60_000

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

/** True while the combo is physically held — push-to-talk's recording state. */
let holding = false
/** When the current hold began, for telling a tap from speech. */
let holdSince = 0
/** Whether the current hold is the second press of a would-be double-tap. */
let secondPress = false
/** Whether a Windows chord key was seen down during the current hold. */
let chorded = false
/**
 * A tap has been released and its take is still rolling, waiting to learn
 * whether a second tap is coming. 0 when no tap is pending.
 */
let tapAt = 0
/**
 * Latched: a hands-free session, recording with nothing held. Ends on the
 * next press of the combo (or at HANDS_FREE_MAX_MS).
 */
let latched = false
let latchedSince = 0
/**
 * The press that ends a hands-free session is the whole gesture: neither it
 * nor the release that follows may also be read as the start of a new take.
 * Swallow every edge until the combo is fully up again.
 */
let swallowing = false
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
  // A hands-free session is the exception: a held key says someone is
  // mid-sentence, but a latched take has no such tell, and recording on
  // behind a muted tray icon is precisely what mute promises not to do.
  if (muted && latched) {
    latched = false
    finishTake(takeCounter)
  }
}
/** Take ids, minted per hold. */
let takeCounter = 0
/**
 * Takes whose audio is still owed or in transcription, keyed by id, valued by
 * their watchdog — null once it has done its job.
 *
 * The watchdog guards exactly one hop: the capture window answering with the
 * audio. If it never does (a dev-server reload mid-take), the watchdog
 * forgets the take so its late answer — should one still come — is recognized
 * as stale and dropped. It is cancelled the moment the audio lands, because
 * everything after that is the network's problem and the network has its own
 * deadline. A watchdog left armed across the OpenAI call would fire on any
 * long take and settle it empty behind the call's back: nothing pastes, then
 * the real transcript arrives with its place in the queue already gone and
 * files itself into History alone. Five minutes of dictation, visible in the
 * History tab, never pasted, no error on screen.
 */
const inFlight = new Map<number, NodeJS.Timeout | null>()
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
 * The mic is open — held, latched, or rolling through a double-tap window.
 * Three states, one question everything else asks.
 */
function recording(): boolean {
  return holding || latched || tapAt !== 0
}

/**
 * One place derives all UI from the two facts that exist: whether the mic is
 * open, and how many takes are still in flight. Recording wins the pill
 * (you're speaking now); otherwise pending work shows as transcribing;
 * otherwise nothing.
 */
function refreshUi(): void {
  const live = recording()
  setTrayRecording(live)
  if (live) showPill(latched ? 'handsFree' : 'recording')
  else if (inFlight.size > 0) showPill('transcribing')
  else hidePill()
}

function sendRecord(event: DictationRecordEvent): void {
  renderer?.send(IPC.dictationRecord, event)
}

/**
 * A take stops recording: its audio is now owed, and transcription happens
 * when it arrives. Every way a take can end — a release, a latching tap's
 * successor, the hands-free cap, a dead mic — comes through here, so the
 * owed-order queue always sees takes in the order they were spoken.
 */
function finishTake(take: number): void {
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

/**
 * The bookkeeping every press of the combo starts, whether it opens a take or
 * continues one: how long it has been down, whether it is the second half of
 * a gesture, and whether Windows' own chord is riding along with it.
 */
function beginPress(now: number, second: boolean): void {
  holding = true
  holdSince = now
  secondPress = second
  chorded = CHORD_KEYS.some(down)
}

function pollHotkey(): void {
  const combo = down(VK_CONTROL) && (down(VK_LWIN) || down(VK_RWIN))
  const now = Date.now()

  // Tail end of the tap that ended a session: consumed, not a new hold.
  if (swallowing) {
    if (!combo) swallowing = false
    return
  }

  if (combo && !holding) {
    if (latched) {
      // The tap that ends a hands-free session. Focus is wherever the human
      // has wandered to and come back from — that's where the text goes.
      latched = false
      swallowing = true
      finishTake(takeCounter)
      return
    }
    if (tapAt !== 0) {
      // The second press of a would-be double-tap. Whether it latches or is
      // just someone who tapped and then settled into a normal hold is
      // decided at ITS release — so nothing restarts here either way, and
      // the words spoken between the two presses are kept.
      tapAt = 0
      beginPress(now, true)
      return
    }
    if (muted) return
    // Hold began: record until release.
    beginPress(now, false)
    takeCounter++
    sendRecord({ action: 'start', take: takeCounter, chime: getSettings().chime })
    refreshUi()
  } else if (combo && holding) {
    if (!chorded && CHORD_KEYS.some(down)) chorded = true
  } else if (!combo && holding) {
    holding = false
    const tap = getSettings().handsFree && !chorded && now - holdSince <= TAP_MAX_MS
    if (tap && secondPress) {
      // Double-tap complete: the take stops needing the keys and simply
      // keeps recording.
      latched = true
      latchedSince = now
      refreshUi()
      return
    }
    if (tap) {
      // Too short to be speech, so it may be half a gesture: hold the take
      // open for the double-tap window rather than ending it. The pill keeps
      // saying Listening, because it still is.
      tapAt = now
      return
    }
    // Ordinary release. Holding again immediately starts the next take in
    // parallel with this one's transcription.
    finishTake(takeCounter)
  } else if (tapAt !== 0 && now - tapAt > DOUBLE_TAP_MS) {
    // No second tap came — it was just a tap. End the take as a release would.
    tapAt = 0
    finishTake(takeCounter)
  } else if (latched && now - latchedSince > HANDS_FREE_MAX_MS) {
    latched = false
    finishTake(takeCounter)
    pillError('hands-free stopped after 5 minutes')
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
 * its transcript away because someone talked for more than two seconds. A
 * leaned-on ending tap counts as legitimate too — the transcript it just
 * asked for must not be dropped for arriving while the key is still down.
 * The timeout only measures keys held outside either case — a stuck or
 * gamer-pinned key — and aborts then, since that chord would never clear.
 */
async function modifiersReleased(): Promise<boolean> {
  let quietSince = Date.now()
  for (;;) {
    if (!down(VK_CONTROL) && !down(VK_LWIN) && !down(VK_RWIN)) return true
    if (holding || swallowing) quietSince = Date.now()
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
 * speaking a newer take, the pill keeps saying Listening (matching the tray)
 * and the old take's error — which already means "nothing will paste" —
 * goes unshown.
 */
function pillError(message: string): void {
  if (recording()) return
  flashPillError(message, refreshUi)
}

/**
 * One take's final word, whatever the path — transcript, silence, error,
 * timeout: leave the in-flight set, park the text for ordered injection,
 * and let the queue advance.
 */
function settleTake(take: number, text: string): void {
  const watchdog = inFlight.get(take)
  if (watchdog) clearTimeout(watchdog)
  inFlight.delete(take)
  resolvedText.set(take, text)
  refreshUi()
  void flushInjects()
}

/**
 * Pastes every take whose turn has come, in speech order, one at a time.
 *
 * A hands-free session pauses the queue. Releasing a take and immediately
 * double-tapping to keep going is a natural motion, and it leaves the earlier
 * take resolving a second or two later — by which time the human is off
 * reading something else, and its transcript would paste into whatever window
 * they were passing through. So it waits for the tap that ends the session
 * and lands with it, in the place they deliberately came back to. Held takes
 * can't wait forever: the session itself is capped.
 */
async function flushInjects(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    while (!latched && owedOrder.length > 0 && resolvedText.has(owedOrder[0])) {
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
/**
 * How long the upload and the transcription together may take before the
 * request is abandoned. A push-to-talk take clears the 30s floor with room to
 * spare, but hands-free exists to produce minutes-long takes, and both the
 * bytes going up and the work done on them grow with the audio — so the
 * budget grows too, at a quarter of realtime. A capped-out five-minute
 * session gets 105s, several times anything the endpoint has needed.
 */
function transcribeBudgetMs(seconds: number): number {
  const capSeconds = HANDS_FREE_MAX_MS / 1000
  const clamped = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), capSeconds) : 0
  // Rounded because AbortSignal.timeout rejects a fractional delay outright,
  // and a take's duration is fractional seconds nearly every time.
  return Math.round(30_000 + clamped * 250)
}

async function transcribe(audio: Uint8Array, mime: string, seconds: number): Promise<string> {
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
    // A hung upload must not strand the take.
    signal: AbortSignal.timeout(transcribeBudgetMs(seconds))
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
  // The recorder answered: the watchdog's whole job is done, and leaving it
  // armed through the transcription is how a long take loses its transcript.
  const watchdog = inFlight.get(take)
  if (watchdog) clearTimeout(watchdog)
  inFlight.set(take, null)

  try {
    // Sub-half-second of opus is a misfire (a tapped combo, a desktop
    // switch), not speech — don't spend a request learning it transcribes
    // to nothing. The injection itself is not awaited here: its turn in the
    // speech-ordered queue may be behind takes still transcribing; a paste
    // failure surfaces on the pill.
    const text =
      audio.byteLength < 2000
        ? ''
        : await cleanupTranscript(await transcribe(audio, mime, seconds))
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
    // A latched session has no held key to end it, so a mic that never opened
    // would leave it "listening" to nothing until the cap. End it here; the
    // capture window has already dropped the take, so the stop order comes
    // back as a silent one and the queue unwinds normally.
    if (latched) {
      latched = false
      finishTake(takeCounter)
    }
    pillError(message || 'microphone unavailable')
  })
  // The pill's wave: mic band levels from the capture window's analyser,
  // forwarded only while the hold is actually up — a straggler frame from a
  // take that just ended must not twitch a pill that has moved on.
  ipcMain.on(IPC.dictationLevel, (_e, bands: number[]) => {
    if (recording() && Array.isArray(bands)) pillLevels(bands)
  })
  pollTimer = setInterval(pollHotkey, POLL_MS)
  pollTimer.unref()
}

export function stopDictation(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  renderer = null
  holding = false
  latched = false
  tapAt = 0
  swallowing = false
  for (const watchdog of inFlight.values()) if (watchdog) clearTimeout(watchdog)
  inFlight.clear()
  owedOrder.length = 0
  resolvedText.clear()
}
