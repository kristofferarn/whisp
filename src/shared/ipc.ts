/**
 * The IPC contract between whisp's three worlds: main (hotkey, pill,
 * transcription, paste), the hidden capture window (the microphone), and the
 * settings window (the visible UI). Everything the preload bridge exposes is
 * typed here so the three can't drift.
 */

export const IPC = {
  /** Main → capture: start/stop recording a take. */
  dictationRecord: 'dictation:record',
  /** Capture → main: the take's audio, answered with the transcript. */
  dictationTranscribe: 'dictation:transcribe',
  /** Capture → main: the mic wouldn't open — surface it on the pill. */
  dictationMicError: 'dictation:micError',
  /** Capture → main: live mic band levels for the pill's wave. */
  dictationLevel: 'dictation:level',

  keyStatus: 'key:status',
  keySet: 'key:set',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  historyList: 'history:list',
  historyClear: 'history:clear',
  statsGet: 'stats:get',
  /** Main → settings UI: something it shows (settings/history/stats) changed. */
  dataChanged: 'data:changed'
} as const

export interface DictationRecordEvent {
  action: 'start' | 'stop'
  /**
   * Which take this order belongs to, minted by main. The capture window
   * echoes it back on dictationTranscribe so a late answer — one that
   * outlived the watchdog while a newer take is live — identifies itself and
   * is dropped instead of pasting stale text. Takes overlap by design:
   * hold-to-talk can start the next recording while the previous take is
   * still transcribing.
   */
  take: number
  /** On 'start': whether to play the mic-ready tick (a settings toggle). */
  chime?: boolean
  /** On 'start': the chosen input device, or null to follow the Windows default. */
  microphoneId?: string | null
}

export type DictationTranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

/**
 * The transcription models whisp can drive, both on the same REST endpoint.
 * The mini model is the cheap default (~$0.003/min vs ~$0.0045) but its API
 * takes at most ONE language hint; gpt-transcribe takes the whole set of
 * expected languages — the cure for Norwegian coming back as Swedish.
 * Costs live on the OpenAI dashboard, not here.
 */
export const TRANSCRIBE_MODELS = [
  { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini' },
  { id: 'gpt-transcribe', label: 'gpt-transcribe' }
] as const

export type TranscribeModel = (typeof TRANSCRIBE_MODELS)[number]['id']

/**
 * The languages whisp's human actually speaks — the pool the transcriber
 * should pick from instead of guessing among ~100 neighbors. ISO-639-1;
 * 'no' covers Bokmål and Nynorsk both. Add a language by adding a row.
 */
export const DICTATION_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'no', label: 'Norwegian' }
] as const

export type DictationLanguage = (typeof DICTATION_LANGUAGES)[number]['code']

export const DICTATION_AUDIO_BEHAVIORS = [
  { id: 'lower', label: 'Lower volume' },
  { id: 'pause', label: 'Pause media' },
  { id: 'none', label: 'Keep playing' }
] as const

export type DictationAudioBehavior = (typeof DICTATION_AUDIO_BEHAVIORS)[number]['id']

export interface WhispSettings {
  /**
   * Vocabulary bias for the transcriber — names and jargon it would
   * otherwise mishear. Joined into the transcription request's prompt.
   */
  dictionary: string[]
  /** Which transcription model requests use (a Settings knob, price vs. accuracy). */
  model: TranscribeModel
  /**
   * Spoken languages, hinted with every request. gpt-transcribe takes the
   * whole set; the mini model's API fits one code, so it's hinted only when
   * exactly one is selected. Empty (or several, on mini) detects freely.
   */
  languages: DictationLanguage[]
  /**
   * The double-tap gesture: tapping Ctrl+Win twice quickly latches the take
   * into a hands-free session that records with nothing held, until the next
   * tap. Off restores pure push-to-talk — every release ends its take
   * immediately, with no window spent waiting for a second tap.
   */
  handsFree: boolean
  /** The near-subliminal tick when the mic actually opens. */
  chime: boolean
  /** Input device id, or null to follow the current Windows default microphone. */
  microphoneId: string | null
  /** What happens to Windows playback while the microphone is open. */
  audioBehavior: DictationAudioBehavior
  /** Keep a local log of transcripts (History tab). Stats accrue regardless. */
  keepHistory: boolean
  /** Start whisp when Windows starts (applies to the installed build). */
  launchAtLogin: boolean
}

export const DEFAULT_SETTINGS: WhispSettings = {
  dictionary: [],
  model: 'gpt-4o-mini-transcribe',
  languages: ['en', 'no'],
  handsFree: true,
  chime: true,
  microphoneId: null,
  audioBehavior: 'lower',
  keepHistory: true,
  launchAtLogin: false
}

export interface KeyStatus {
  configured: boolean
  last4: string | null
}

export interface HistoryEntry {
  /** Unix ms when the take resolved. */
  ts: number
  text: string
  /** Recorded duration in seconds. */
  seconds: number
}

export interface DayStats {
  takes: number
  seconds: number
  words: number
}

export interface Stats {
  totalTakes: number
  totalSeconds: number
  totalWords: number
  /** Per-day buckets keyed YYYY-MM-DD (local time), pruned to recent days. */
  days: Record<string, DayStats>
}

/**
 * The preload bridge, `window.whisp`. One bridge serves both windows: the
 * capture window uses `dictation`, the settings window uses the rest.
 */
export interface WhispApi {
  dictation: {
    onRecord: (listener: (e: DictationRecordEvent) => void) => () => void
    transcribe: (
      audio: Uint8Array,
      mime: string,
      take: number,
      seconds: number
    ) => Promise<DictationTranscribeResult>
    micError: (message: string) => void
    level: (bands: number[]) => void
  }
  key: {
    status: () => Promise<KeyStatus>
    /** Pass null (or empty) to clear the stored key. */
    set: (key: string | null) => Promise<KeyStatus>
  }
  settings: {
    get: () => Promise<WhispSettings>
    set: (patch: Partial<WhispSettings>) => Promise<WhispSettings>
  }
  history: {
    list: () => Promise<HistoryEntry[]>
    clear: () => Promise<void>
  }
  stats: {
    get: () => Promise<Stats>
  }
  onDataChanged: (listener: () => void) => () => void
}
