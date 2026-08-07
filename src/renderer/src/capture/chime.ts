/**
 * whisp's one earcon, synthesized with WebAudio rather than shipped as a
 * file: an oscillator and an envelope, so there are no assets to license or
 * bundle.
 *
 * The tick fires when the mic is truly capturing — the pill says "Listening"
 * the instant the hotkey fires, but getUserMedia on Windows opens the device
 * noticeably later, and words spoken before that are lost. The tick is the
 * honest signal; the pill is the optimistic one. It plays on every hold, so
 * it must stay near-subliminal.
 *
 * Renderer-side on purpose: main has no audio stack, and the hidden capture
 * window plays sound the same way it records. Electron's autoplay policy
 * allows audio without a gesture, but the context can still wake suspended —
 * every play resumes it and schedules from currentTime.
 */

let ctx: AudioContext | null = null

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}

/** One enveloped note, scheduled `at` seconds from now. */
function note(freq: number, at: number, duration: number, peak: number): void {
  const ac = audio()
  const t = ac.currentTime + at
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)
  osc.connect(gain).connect(ac.destination)
  osc.start(t)
  osc.stop(t + duration + 0.05)
}

/** The dictation mic is open and capturing — one quiet tick. */
export function dictationReadyChime(): void {
  note(987.77, 0, 0.09, 0.045)
}
