import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type IpcMain } from 'electron'
import {
  DEFAULT_SETTINGS,
  DICTATION_LANGUAGES,
  IPC,
  TRANSCRIBE_MODELS,
  type DayStats,
  type DictationLanguage,
  type HistoryEntry,
  type Stats,
  type TranscribeModel,
  type WhispSettings
} from '../shared/ipc'

/**
 * whisp's persistence: three JSON files in userData, each loaded once at
 * boot and kept in memory — the app is the only writer, so the memory copy
 * is the truth and the files are just its shadow. Writes are fire-and-forget
 * with a serialization queue per file so two takes resolving close together
 * can't interleave their writes.
 *
 * - settings.json  — the dialog's knobs (dictionary, chime, history, login)
 * - history.json   — recent transcripts, capped, only while keepHistory
 * - stats.json     — aggregate + per-day tallies; accrue regardless of history
 */

const HISTORY_MAX = 500
/** Per-day buckets kept this long; totals never lose what pruning drops. */
const DAYS_KEPT = 90

const EMPTY_STATS: Stats = {
  totalTakes: 0,
  totalSeconds: 0,
  totalWords: 0,
  days: {}
}

let settings: WhispSettings = { ...DEFAULT_SETTINGS }
let history: HistoryEntry[] = []
let stats: Stats = structuredClone(EMPTY_STATS)

/** Fired on any change the settings UI shows; index.ts forwards it there. */
let onChange: (() => void) | null = null

export function setStoreListener(listener: () => void): void {
  onChange = listener
}

function filePath(name: string): string {
  return join(app.getPath('userData'), name)
}

function loadJson<T>(name: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(filePath(name), 'utf8')) as T) }
  } catch {
    // Missing on first run, or corrupt — either way start from the fallback;
    // the next write repairs the file.
    return structuredClone(fallback)
  }
}

/** One write in flight per file, latest state wins — never interleaved. */
const writeQueue = new Map<string, Promise<void>>()

function persist(name: string, value: unknown): void {
  const prev = writeQueue.get(name) ?? Promise.resolve()
  const next = prev
    .then(() => writeFile(filePath(name), JSON.stringify(value), 'utf8'))
    .catch((err) => console.error(`whisp: failed to write ${name}:`, err))
  writeQueue.set(name, next)
}

function changed(): void {
  onChange?.()
}

export function initStore(): void {
  settings = loadJson('settings.json', DEFAULT_SETTINGS)
  settings.languages = sanitizeLanguages(settings.languages, DEFAULT_SETTINGS.languages)
  settings.model = sanitizeModel(settings.model, DEFAULT_SETTINGS.model)
  settings.microphoneId = sanitizeMicrophoneId(settings.microphoneId)
  // History loads as a bare array, not an object merge.
  try {
    const parsed = JSON.parse(readFileSync(filePath('history.json'), 'utf8')) as unknown
    history = Array.isArray(parsed) ? (parsed as HistoryEntry[]) : []
  } catch {
    history = []
  }
  stats = loadJson('stats.json', EMPTY_STATS)
  applyLoginItem()
}

export function getSettings(): WhispSettings {
  return settings
}

/**
 * Launch-at-login is only wired for the installed build: in dev,
 * setLoginItemSettings would register the bare electron.exe, which boots to
 * nothing. The preference still persists, so packaging picks it up.
 */
function applyLoginItem(): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
}

function sanitizeDictionary(words: unknown): string[] {
  if (!Array.isArray(words)) return settings.dictionary
  const seen = new Set<string>()
  const clean: string[] = []
  for (const word of words) {
    if (typeof word !== 'string') continue
    const trimmed = word.trim().slice(0, 64)
    const fold = trimmed.toLowerCase()
    if (!trimmed || seen.has(fold)) continue
    seen.add(fold)
    clean.push(trimmed)
  }
  // The prompt rides every request; a boundless dictionary would bloat it.
  return clean.slice(0, 100)
}

/**
 * Only known codes survive, in canonical order and deduped — anything else
 * (a hand-edited file, an old build's value) drops out rather than ride
 * every request until the API rejects it.
 */
function sanitizeLanguages(codes: unknown, fallback: DictationLanguage[]): DictationLanguage[] {
  if (!Array.isArray(codes)) return fallback
  return DICTATION_LANGUAGES.map((l) => l.code).filter((code) => codes.includes(code))
}

function sanitizeModel(id: unknown, fallback: TranscribeModel): TranscribeModel {
  return TRANSCRIBE_MODELS.some((m) => m.id === id) ? (id as TranscribeModel) : fallback
}

function sanitizeMicrophoneId(id: unknown): string | null {
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  return trimmed ? trimmed.slice(0, 512) : null
}

export function setSettings(patch: Partial<WhispSettings>): WhispSettings {
  settings = {
    ...settings,
    ...patch,
    dictionary: patch.dictionary !== undefined ? sanitizeDictionary(patch.dictionary) : settings.dictionary,
    languages:
      patch.languages !== undefined
        ? sanitizeLanguages(patch.languages, settings.languages)
        : settings.languages,
    model: patch.model !== undefined ? sanitizeModel(patch.model, settings.model) : settings.model,
    microphoneId:
      patch.microphoneId !== undefined
        ? sanitizeMicrophoneId(patch.microphoneId)
        : settings.microphoneId
  }
  if (!settings.keepHistory && history.length > 0) {
    // Turning history off is a statement of intent about the past too.
    history = []
    persist('history.json', history)
  }
  persist('settings.json', settings)
  applyLoginItem()
  changed()
  return settings
}

export function getHistory(): HistoryEntry[] {
  return history
}

export function clearHistory(): void {
  history = []
  persist('history.json', history)
  changed()
}

export function getStats(): Stats {
  return stats
}

function localDayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * One successful take's bookkeeping: aggregate stats always, a history entry
 * only while keepHistory. Words are whitespace-split — crude, but stable and
 * language-agnostic enough for a personal tally.
 */
export function recordTake(text: string, seconds: number): void {
  const words = text.split(/\s+/).filter(Boolean).length
  const now = new Date()

  stats.totalTakes += 1
  stats.totalSeconds += seconds
  stats.totalWords += words

  const key = localDayKey(now)
  const day: DayStats = stats.days[key] ?? { takes: 0, seconds: 0, words: 0 }
  day.takes += 1
  day.seconds += seconds
  day.words += words
  stats.days[key] = day

  const dayKeys = Object.keys(stats.days).sort()
  for (const stale of dayKeys.slice(0, Math.max(0, dayKeys.length - DAYS_KEPT))) {
    delete stats.days[stale]
  }
  persist('stats.json', stats)

  if (settings.keepHistory) {
    history.unshift({ ts: now.getTime(), text, seconds })
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX
    persist('history.json', history)
  }
  changed()
}

export function registerStoreHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.settingsGet, () => getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<WhispSettings>) => setSettings(patch))
  ipcMain.handle(IPC.historyList, () => getHistory())
  ipcMain.handle(IPC.historyClear, () => clearHistory())
  ipcMain.handle(IPC.statsGet, () => getStats())
}
