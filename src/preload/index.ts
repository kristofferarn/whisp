import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type DictationRecordEvent,
  type DictationTranscribeResult,
  type HistoryEntry,
  type KeyStatus,
  type Stats,
  type WhispApi,
  type WhispSettings
} from '../shared/ipc'

/**
 * The one bridge, `window.whisp`, shared by both windows: the hidden capture
 * window uses `dictation` (main's record orders in, audio back out), the
 * settings window uses the rest. Splitting it per-window would buy nothing —
 * neither surface can do anything the other's channels don't already allow.
 */

const api: WhispApi = {
  dictation: {
    onRecord: (listener: (e: DictationRecordEvent) => void): (() => void) => {
      const handler = (_: unknown, e: DictationRecordEvent): void => listener(e)
      ipcRenderer.on(IPC.dictationRecord, handler)
      return () => ipcRenderer.off(IPC.dictationRecord, handler)
    },
    transcribe: (
      audio: Uint8Array,
      mime: string,
      take: number,
      seconds: number
    ): Promise<DictationTranscribeResult> =>
      ipcRenderer.invoke(IPC.dictationTranscribe, audio, mime, take, seconds),
    micError: (message: string): void => ipcRenderer.send(IPC.dictationMicError, message),
    /** Live mic band levels (0..1) while recording, for the pill's wave. */
    level: (bands: number[]): void => ipcRenderer.send(IPC.dictationLevel, bands)
  },
  key: {
    status: (): Promise<KeyStatus> => ipcRenderer.invoke(IPC.keyStatus),
    set: (key: string | null): Promise<KeyStatus> => ipcRenderer.invoke(IPC.keySet, key)
  },
  settings: {
    get: (): Promise<WhispSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<WhispSettings>): Promise<WhispSettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  history: {
    list: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.historyList),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear)
  },
  stats: {
    get: (): Promise<Stats> => ipcRenderer.invoke(IPC.statsGet)
  },
  onDataChanged: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.dataChanged, handler)
    return () => ipcRenderer.off(IPC.dataChanged, handler)
  }
}

contextBridge.exposeInMainWorld('whisp', api)
