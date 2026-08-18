import { dictationReadyChime } from './chime'

/**
 * The capture window's whole job: the microphone.
 *
 * Main runs the show — hotkey, pill, transcription, paste — and only tells
 * this module "record take N" and "stop take N"; the audio goes straight
 * back over one invoke. getUserMedia is the reason this window exists at all
 * (main has no media stack), and it works hidden, which is what makes
 * system-wide dictation possible from a windowless app.
 *
 * Takes are keyed by main's id and independent of each other: with
 * hold-to-talk, the next recording can start while the previous take's
 * upload is still in flight, so nothing here is a singleton. All UI lives in
 * main's pill; the one thing this module reports is a mic that wouldn't
 * open, which would otherwise fail in silence.
 */

interface Take {
  recorder: MediaRecorder | null
  chunks: Blob[]
  startedAt: number
  /** Set when the stop order arrives — including before the mic finished
   *  opening, in which case the late stream is released on arrival. */
  stopped: boolean
  /** Tears down the level meter feeding the pill's wave; null before it runs. */
  stopMeter: (() => void) | null
  /** Meter frames that crossed speech level — the silence gate's evidence. */
  voicedFrames: number
  /** Play the mic-ready tick for this take (the settings toggle, sent by main). */
  chime: boolean
}

const takes = new Map<number, Take>()

/** Bands in the pill's wave — must match the bar count in main/pill.ts. */
const METER_BANDS = 5
/** ~20 fps: fluid to the eye, trivial as IPC traffic. */
const METER_MS = 50

/**
 * The silence gate. A take with no speech in it must never be uploaded:
 * transcription models hand a vocabulary prompt back verbatim when the audio
 * is silent, and the upload bills for learning nothing. The meter already
 * measures voice-weighted energy for the pill, so speech is defined from it:
 * a band peak above SPEECH_BAND (ordinary speech reads ~0.6+ after the sqrt
 * shaping, suppressed room noise near zero), sustained for MIN_VOICED_FRAMES
 * frames (~150ms) so a key click or a cough can't impersonate a sentence.
 */
const SPEECH_BAND = 0.3
const MIN_VOICED_FRAMES = 3

/**
 * Feeds the pill its proof-of-hearing: an AnalyserNode on the same stream the
 * recorder captures, folded into a few frequency bands weighted toward voice.
 * Levels are shaped (sqrt) so ordinary speech visibly moves the bars rather
 * than trembling at the bottom. Returns the teardown.
 */
function startMeter(stream: MediaStream, take: Take): () => void {
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.6
  ctx.createMediaStreamSource(stream).connect(analyser)
  const bins = new Uint8Array(analyser.frequencyBinCount)

  const timer = window.setInterval(() => {
    analyser.getByteFrequencyData(bins)
    // The bottom quarter of the spectrum is where voice lives at this fft
    // size (0–~6kHz over 32 of 128 bins); the rest is hiss that would flatten
    // the bars' dynamics.
    const usable = Math.max(METER_BANDS, Math.floor(bins.length / 4))
    const per = Math.floor(usable / METER_BANDS)
    const bands: number[] = []
    for (let b = 0; b < METER_BANDS; b++) {
      let sum = 0
      for (let i = 0; i < per; i++) sum += bins[b * per + i]
      bands.push(Math.sqrt(sum / per / 255))
    }
    if (Math.max(...bands) > SPEECH_BAND) take.voicedFrames++
    window.whisp.dictation.level(bands)
  }, METER_MS)

  return () => {
    window.clearInterval(timer)
    void ctx.close().catch(() => undefined)
  }
}

function unavailableMicrophone(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' ||
      error.name === 'OverconstrainedError' ||
      error.name === 'NotReadableError' ||
      error.name === 'AbortError')
  )
}

function missingMicrophone(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
  )
}

/**
 * A saved device is preferred, but never allowed to make dictation inert.
 * If Windows no longer exposes it, forget the choice and retry through the
 * system-default path. Other failures, such as denied permission or a busy
 * device, need to reach the pill instead of being disguised as a fallback.
 */
async function openMicrophone(microphoneId: string | null): Promise<MediaStream> {
  if (!microphoneId) return navigator.mediaDevices.getUserMedia({ audio: true })

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: microphoneId } }
    })
  } catch (error) {
    if (!unavailableMicrophone(error)) throw error
    // A missing device is gone from Windows' list, so the saved choice is no
    // longer useful. Busy/aborted devices can be transient: use the default
    // for this take without forgetting the preference.
    if (missingMicrophone(error)) {
      await window.whisp.settings.set({ microphoneId: null }).catch(() => undefined)
    }
    return navigator.mediaDevices.getUserMedia({ audio: true })
  }
}

async function startRecording(
  id: number,
  chime: boolean,
  microphoneId: string | null
): Promise<void> {
  if (takes.has(id)) return
  const take: Take = {
    recorder: null,
    chunks: [],
    startedAt: Date.now(),
    stopped: false,
    stopMeter: null,
    voicedFrames: 0,
    chime
  }
  takes.set(id, take)

  let stream: MediaStream | null = null
  try {
    stream = await openMicrophone(microphoneId)
    // A short hold releases before the mic finishes opening; stopRecording
    // already answered main with a silent take, so just let the mic go.
    if (take.stopped) {
      for (const track of stream.getTracks()) track.stop()
      takes.delete(id)
      return
    }
    take.recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    take.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) take.chunks.push(e.data)
    }
    take.recorder.start()
    take.stopMeter = startMeter(stream, take)
    // Words spoken before this line are lost — the pill's "Listening" shows
    // at the hotkey, but the mic only opened now. The tick marks the truth.
    if (take.chime) dictationReadyChime()
  } catch (err) {
    // Mic refused or missing — or MediaRecorder itself balked after the mic
    // was granted, in which case the live stream must not leak: an orphaned
    // stream keeps the OS mic-in-use indicator on with nothing recording.
    if (stream) for (const track of stream.getTracks()) track.stop()
    takes.delete(id)
    window.whisp.dictation.micError(err instanceof Error ? err.message : String(err))
  }
}

async function stopRecording(id: number): Promise<void> {
  const take = takes.get(id)

  if (!take || !take.recorder) {
    // Nothing was ever captured — the mic failed, or is still opening. Main
    // is owed an answer either way; a silent take resolves it to nothing.
    if (take) take.stopped = true
    void window.whisp.dictation
      .transcribe(new Uint8Array(), 'audio/webm', id, 0)
      .catch(() => undefined)
    return
  }

  take.stopped = true
  take.stopMeter?.()
  take.stopMeter = null
  const active = take.recorder
  let settle!: () => void
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  active.onstop = () => settle()
  const durationS = (Date.now() - take.startedAt) / 1000
  // A recorder that is already inactive — or whose stop() throws because it
  // is — will never fire onstop; settle by hand or this coroutine (and the
  // take entry) waits forever. The race below is the same guard against any
  // implementation that just never delivers the event.
  if (active.state === 'inactive') {
    settle()
  } else {
    try {
      active.stop()
    } catch {
      settle()
    }
  }
  for (const track of active.stream.getTracks()) track.stop()
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])

  try {
    // The silence gate: a take the meter never heard speech in resolves as a
    // silent take without touching the network — no upload to bill, and no
    // prompt-echo hallucination to paste.
    const blob = new Blob(take.chunks, { type: active.mimeType || 'audio/webm' })
    const audio =
      take.voicedFrames >= MIN_VOICED_FRAMES
        ? new Uint8Array(await blob.arrayBuffer())
        : new Uint8Array()
    // Duration rides along for main's history and stats.
    await window.whisp.dictation.transcribe(audio, blob.type, id, durationS)
  } catch {
    // Main's watchdog forgets the take if this answer never arrives; the
    // silent take here is just the faster path to that same end.
    void window.whisp.dictation
      .transcribe(new Uint8Array(), 'audio/webm', id, 0)
      .catch(() => undefined)
  } finally {
    takes.delete(id)
  }
}

// Wire-up: main's orders, for as long as the app lives.
window.whisp.dictation.onRecord((e) => {
  if (e.action === 'start') {
    void startRecording(e.take, e.chime !== false, e.microphoneId ?? null)
  }
  else void stopRecording(e.take)
})
