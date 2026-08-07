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
}

export type DictationTranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

export interface WhispSettings {
  /**
   * Vocabulary bias for the transcriber — names and jargon it would
   * otherwise mishear. Joined into the transcription request's prompt.
   */
  dictionary: string[]
  /** The near-subliminal tick when the mic actually opens. */
  chime: boolean
  /** Keep a local log of transcripts (History tab). Stats accrue regardless. */
  keepHistory: boolean
  /** Start whisp when Windows starts (applies to the installed build). */
  launchAtLogin: boolean
}

export const DEFAULT_SETTINGS: WhispSettings = {
  dictionary: [],
  chime: true,
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
  /** Recorded duration in seconds — what the transcription billed. */
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
  totalCostUsd: number
  /** Per-day buckets keyed YYYY-MM-DD (local time), pruned to recent days. */
  days: Record<string, DayStats>
}

export const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'
/** gpt-4o-mini-transcribe bills ~$0.003 per minute of audio. */
export const TRANSCRIBE_USD_PER_SECOND = 0.003 / 60

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
