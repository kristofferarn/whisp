import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DICTATION_AUDIO_BEHAVIORS,
  DICTATION_LANGUAGES,
  TRANSCRIBE_MODELS,
  type DictationLanguage,
  type HistoryEntry,
  type KeyStatus,
  type Stats,
  type WhispSettings
} from '../../../shared/ipc'
import { BreathLine } from './BreathLine'
import { TitleBar } from './TitleBar'

/**
 * The settings window — whisp's whole visible surface, arranged the way the
 * app works rather than the way it's stored. Listen is the microphone side:
 * device, what happens to playback, the gestures. Transcribe is what happens
 * to the voice once the mic closes: key, model, languages, cleanup, the
 * dictionary. History and Stats are the record. All of it re-fetches on
 * main's dataChanged push, so a dictation landing while the window is open
 * updates History and Stats live — and flares the mark in the title bar, which is
 * how the app says "heard you" without a toast.
 */

type Tab = 'listen' | 'transcribe' | 'history' | 'stats'

const TABS: { id: Tab; label: string; icon: React.JSX.Element }[] = [
  { id: 'listen', label: 'Listen', icon: <MicIcon /> },
  { id: 'transcribe', label: 'Transcribe', icon: <TextIcon /> },
  { id: 'history', label: 'History', icon: <ClockIcon /> },
  { id: 'stats', label: 'Stats', icon: <BarsIcon /> }
]

interface Data {
  settings: WhispSettings
  key: KeyStatus
  history: HistoryEntry[]
  stats: Stats
}

async function fetchAll(): Promise<Data> {
  const [settings, key, history, stats] = await Promise.all([
    window.whisp.settings.get(),
    window.whisp.key.status(),
    window.whisp.history.list(),
    window.whisp.stats.get()
  ])
  return { settings, key, history, stats }
}

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('listen')
  const [data, setData] = useState<Data | null>(null)
  const [flare, setFlare] = useState(false)
  const flareTimer = useRef<number | null>(null)

  const refresh = useCallback(() => {
    void fetchAll().then(setData)
  }, [])

  useEffect(() => {
    refresh()
    const off = window.whisp.onDataChanged(() => {
      refresh()
      setFlare(true)
      if (flareTimer.current !== null) window.clearTimeout(flareTimer.current)
      flareTimer.current = window.setTimeout(() => setFlare(false), 1100)
    })
    return () => {
      off()
      if (flareTimer.current !== null) window.clearTimeout(flareTimer.current)
    }
  }, [refresh])

  if (!data) return <div className="app" />

  return (
    <div className="app">
      <TitleBar flare={flare} />
      <div className="frame">
        <nav className="sidebar" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`sidebar__item${tab === t.id ? ' sidebar__item--active' : ''}`}
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <main className="content">
          {tab === 'listen' && <Listen data={data} goToKey={() => setTab('transcribe')} />}
          {tab === 'transcribe' && <Transcribe data={data} refresh={refresh} />}
          {tab === 'history' && <History data={data} />}
          {tab === 'stats' && <StatsTab stats={data.stats} />}
        </main>
      </div>
    </div>
  )
}

/* Listen ------------------------------------------------------------------ */

function Listen({ data, goToKey }: { data: Data; goToKey: () => void }): React.JSX.Element {
  const { settings, key } = data
  return (
    <section>
      <h1>Listen</h1>
      <p className="lede">
        Hold <kbd>Ctrl</kbd>+<kbd>Win</kbd> anywhere, speak, release. Double-tap to keep
        listening with the keys up.
      </p>

      {!key.configured && (
        <div className="banner">
          <span>Dictation needs an OpenAI API key before it can transcribe anything.</span>
          <button className="primary" onClick={goToKey}>
            Add key
          </button>
        </div>
      )}

      <div className="card">
        <MicTest microphoneId={settings.microphoneId} />
        <MicrophonePicker settings={settings} />
      </div>

      <div className="card">
        <h2 className="card__title">While you dictate</h2>
        <Setting stacked label="Music and video" hint={audioBehaviorHint(settings.audioBehavior)}>
          <Segmented
            ariaLabel="Music and video while dictating"
            options={DICTATION_AUDIO_BEHAVIORS.map((b) => ({ id: b.id, label: b.label }))}
            value={settings.audioBehavior}
            onChange={(id) => void window.whisp.settings.set({ audioBehavior: id })}
          />
        </Setting>
        <Toggle
          label="Hands-free double-tap"
          hint="Tap Ctrl+Win twice quickly and whisp keeps listening with the keys released. Tap once more with the target focused to paste there. Stops on its own after 5 minutes."
          checked={settings.handsFree}
          onChange={(v) => void window.whisp.settings.set({ handsFree: v })}
        />
        <Toggle
          label="Mic-ready tick"
          hint="A near-subliminal chirp when the microphone is actually capturing. Anything said before it plays is lost."
          checked={settings.chime}
          onChange={(v) => void window.whisp.settings.set({ chime: v })}
        />
      </div>

      <div className="card">
        <h2 className="card__title">On this PC</h2>
        <Toggle
          label="Launch at login"
          hint="Start whisp with Windows. Takes effect in the installed build; in dev it only stores the preference."
          checked={settings.launchAtLogin}
          onChange={(v) => void window.whisp.settings.set({ launchAtLogin: v })}
        />
      </div>
    </section>
  )
}

function audioBehaviorHint(behavior: WhispSettings['audioBehavior']): string {
  if (behavior === 'lower') {
    return 'Windows output drops to 15% while you speak, then comes back.'
  }
  if (behavior === 'pause') {
    return 'Playing media pauses while you speak; only what whisp paused resumes.'
  }
  return 'Playback carries on unchanged.'
}

/**
 * The live proof: the same breath line as the pill, fed by the microphone
 * this window would pick. Opt-in and short-lived — the mic opens on the
 * button and closes itself after a few seconds, so whisp never sits on the
 * microphone while settings are merely open.
 */
type MicTestState = 'idle' | 'opening' | 'listening' | 'heard' | 'silent' | 'failed'

const MIC_TEST_MS = 10_000
const MIC_TEST_BANDS = 5
const MIC_TEST_SPEECH = 0.3

function MicTest({ microphoneId }: { microphoneId: string | null }): React.JSX.Element {
  const [state, setState] = useState<MicTestState>('idle')
  const bands = useRef<number[]>([0, 0, 0, 0, 0])
  const session = useRef<{ stop: () => void } | null>(null)
  const heard = useRef(false)

  const stop = useCallback(() => {
    session.current?.stop()
    session.current = null
    bands.current = [0, 0, 0, 0, 0]
  }, [])

  useEffect(() => stop, [stop])
  // A different microphone mid-test would be testing the wrong thing.
  useEffect(() => {
    if (session.current) {
      stop()
      setState('idle')
    }
  }, [microphoneId, stop])

  const start = async (): Promise<void> => {
    stop()
    heard.current = false
    setState('opening')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true
      })
    } catch {
      setState('failed')
      return
    }
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    ctx.createMediaStreamSource(stream).connect(analyser)
    const bins = new Uint8Array(analyser.frequencyBinCount)
    const meter = window.setInterval(() => {
      analyser.getByteFrequencyData(bins)
      const usable = Math.max(MIC_TEST_BANDS, Math.floor(bins.length / 4))
      const per = Math.floor(usable / MIC_TEST_BANDS)
      const next: number[] = []
      for (let b = 0; b < MIC_TEST_BANDS; b++) {
        let sum = 0
        for (let i = 0; i < per; i++) sum += bins[b * per + i]
        next.push(Math.sqrt(sum / per / 255))
      }
      bands.current = next
      if (!heard.current && Math.max(...next) > MIC_TEST_SPEECH) {
        heard.current = true
        setState('heard')
      }
    }, 50)
    const timer = window.setTimeout(() => {
      stop()
      setState(heard.current ? 'idle' : 'silent')
    }, MIC_TEST_MS)
    session.current = {
      stop: () => {
        window.clearInterval(meter)
        window.clearTimeout(timer)
        stream.getTracks().forEach((t) => t.stop())
        void ctx.close().catch(() => undefined)
      }
    }
    setState('listening')
  }

  const live = state === 'listening' || state === 'heard'
  const message: Record<MicTestState, string> = {
    idle: 'Test the microphone whisp would use.',
    opening: 'Opening the microphone…',
    listening: 'Say something.',
    heard: 'Hearing you.',
    silent: 'Nothing came through. Try another microphone below.',
    failed: 'The microphone would not open. Check Windows privacy settings or pick another below.'
  }

  return (
    <div className="mictest">
      <BreathLine bands={bands} live={live} />
      <div className="mictest__row">
        <span className={`mictest__status${state === 'heard' ? ' mictest__status--good' : ''}`}>
          {message[state]}
        </span>
        {live ? (
          <button
            onClick={() => {
              stop()
              setState('idle')
            }}
          >
            Stop
          </button>
        ) : (
          <button disabled={state === 'opening'} onClick={() => void start()}>
            Test microphone
          </button>
        )}
      </div>
    </div>
  )
}

function MicrophonePicker({ settings }: { settings: WhispSettings }): React.JSX.Element {
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setMicrophones(
        devices.filter(
          (device) =>
            device.kind === 'audioinput' &&
            device.deviceId !== 'default' &&
            device.deviceId !== 'communications'
        )
      )
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  const selectedIsMissing =
    loaded &&
    settings.microphoneId !== null &&
    !microphones.some((device) => device.deviceId === settings.microphoneId)

  return (
    <Setting
      label="Microphone"
      hint={
        failed
          ? 'Microphones could not be listed.'
          : 'System default follows the input chosen in Windows. A specific microphone is used until it disappears, then whisp falls back to the default.'
      }
    >
      <select
        aria-label="Microphone"
        disabled={!loaded || failed}
        value={settings.microphoneId ?? ''}
        onChange={(event) =>
          void window.whisp.settings.set({ microphoneId: event.target.value || null })
        }
      >
        <option value="">System default</option>
        {selectedIsMissing && (
          <option value={settings.microphoneId ?? ''}>Unavailable microphone</option>
        )}
        {microphones.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `Microphone ${index + 1}`}
          </option>
        ))}
      </select>
    </Setting>
  )
}

/* Transcribe ---------------------------------------------------------------- */

function Transcribe({ data, refresh }: { data: Data; refresh: () => void }): React.JSX.Element {
  const { key, settings } = data
  return (
    <section>
      <h1>Transcribe</h1>
      <p className="lede">What happens to your voice once the microphone closes.</p>

      <KeyCard keyStatus={key} refresh={refresh} />

      <div className="card">
        <h2 className="card__title">Transcriber</h2>
        <Setting
          stacked
          label="Model"
          hint="gpt-4o-mini is the budget pick (about $0.003 a minute) but takes a single language hint. gpt-transcribe (about $0.0045) takes the whole set, so a Norwegian take can't come back as Swedish."
        >
          <Segmented
            ariaLabel="Transcription model"
            options={TRANSCRIBE_MODELS.map((m) => ({ id: m.id, label: m.label }))}
            value={settings.model}
            onChange={(id) => void window.whisp.settings.set({ model: id })}
          />
        </Setting>
        <Setting stacked label="Spoken languages" hint={languageHint(settings)}>
          <div className="seg" role="group" aria-label="Spoken languages">
            {DICTATION_LANGUAGES.map((lang) => {
              const on = settings.languages.includes(lang.code)
              return (
                <button
                  key={lang.code}
                  role="checkbox"
                  aria-checked={on}
                  className={`seg__option${on ? ' seg__option--active' : ''}`}
                  onClick={() => toggleLanguage(settings, lang.code)}
                >
                  {lang.label}
                </button>
              )
            })}
          </div>
        </Setting>
        <Toggle
          label="Clean up transcripts"
          hint="Before pasting, a small text model drops fillers and false starts, applies “scratch that”, and fixes punctuation. Adds about a second. Off pastes the transcriber's words verbatim."
          checked={settings.cleanup}
          onChange={(v) => void window.whisp.settings.set({ cleanup: v })}
        />
      </div>

      <Dictionary words={settings.dictionary} />
    </section>
  )
}

function KeyCard({
  keyStatus,
  refresh
}: {
  keyStatus: KeyStatus
  refresh: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const saveKey = async (): Promise<void> => {
    if (!draft.trim() || busy) return
    setBusy(true)
    try {
      await window.whisp.key.set(draft)
      setDraft('')
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.whisp.key.set(null)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2 className="card__title">OpenAI API key</h2>
      <p className="muted">
        Stored encrypted on this machine and sent only to OpenAI, from the main process.
      </p>
      <div className="row">
        <input
          type="password"
          aria-label="OpenAI API key"
          placeholder={keyStatus.configured ? `Saved, ends in …${keyStatus.last4}` : 'sk-…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveKey()
          }}
        />
        <button className="primary" disabled={!draft.trim() || busy} onClick={() => void saveKey()}>
          {keyStatus.configured ? 'Replace' : 'Save'}
        </button>
        {keyStatus.configured && (
          <button disabled={busy} onClick={() => void clearKey()}>
            Remove
          </button>
        )}
      </div>
      {!keyStatus.configured && (
        <p className="status status--warn">No key yet. Dictation does nothing until one is saved.</p>
      )}
    </div>
  )
}

function toggleLanguage(settings: WhispSettings, code: DictationLanguage): void {
  const next = settings.languages.includes(code)
    ? settings.languages.filter((c) => c !== code)
    : [...settings.languages, code]
  void window.whisp.settings.set({ languages: next })
}

/**
 * What the current model + selection actually sends — the mini model's
 * one-hint limit is the kind of surprise worth spelling out where the
 * choice is made.
 */
function languageHint(settings: WhispSettings): string {
  const labels = DICTATION_LANGUAGES.filter((l) => settings.languages.includes(l.code)).map(
    (l) => l.label
  )
  if (labels.length === 0) return 'Nothing selected, so the transcriber detects freely.'
  if (settings.model === 'gpt-transcribe') {
    return `Hinting ${labels.join(' and ')} with every request.`
  }
  if (labels.length === 1) return `Hinting ${labels[0]} with every request.`
  return 'gpt-4o-mini fits one hint. With several selected it detects freely; switch to gpt-transcribe to send the whole set.'
}

function Dictionary({ words }: { words: string[] }): React.JSX.Element {
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const fresh = draft
      .split(',')
      .map((w) => w.trim())
      .filter((w) => w && !words.includes(w))
    if (fresh.length > 0) void window.whisp.settings.set({ dictionary: [...words, ...fresh] })
    setDraft('')
  }

  const remove = (word: string): void => {
    void window.whisp.settings.set({ dictionary: words.filter((w) => w !== word) })
  }

  return (
    <div className="card">
      <h2 className="card__title">Dictionary</h2>
      <p className="muted">
        Names and jargon the transcriber would otherwise mishear. They ride every request as a
        spelling hint: product names, coworkers, project words.
      </p>
      <div className="row">
        <input
          aria-label="Add a word"
          placeholder="Add a word, or several separated by commas"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <button className="primary" disabled={!draft.trim()} onClick={add}>
          Add
        </button>
      </div>
      {words.length === 0 ? (
        <p className="status">
          Empty is fine. Dictation works without it; this only sharpens spelling.
        </p>
      ) : (
        <div className="chips">
          {words.map((word) => (
            <span key={word} className="chip">
              {word}
              <button
                className="chip__x"
                aria-label={`Remove ${word}`}
                onClick={() => remove(word)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* History ------------------------------------------------------------------- */

function History({ data }: { data: Data }): React.JSX.Element {
  const [copied, setCopied] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const { history, settings } = data

  const copy = (entry: HistoryEntry): void => {
    void navigator.clipboard.writeText(entry.text).then(() => {
      setCopied(entry.ts)
      setTimeout(() => setCopied(null), 1200)
    })
  }

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const shown = needle ? history.filter((e) => e.text.toLowerCase().includes(needle)) : history
    const out: { day: string; entries: HistoryEntry[] }[] = []
    for (const entry of shown) {
      const day = dayLabel(new Date(entry.ts))
      const last = out[out.length - 1]
      if (last && last.day === day) last.entries.push(entry)
      else out.push({ day, entries: [entry] })
    }
    return out
  }, [history, query])

  return (
    <section>
      <div className="section-head">
        <h1>History</h1>
        {history.length > 0 && (
          <button onClick={() => void window.whisp.history.clear()}>Clear all</button>
        )}
      </div>
      <div className="card card--quiet">
        <Toggle
          label="Keep history"
          hint="Store the last 500 transcripts on this machine. Turning it off deletes what's here."
          checked={settings.keepHistory}
          onChange={(v) => void window.whisp.settings.set({ keepHistory: v })}
        />
      </div>
      {history.length > 0 && (
        <input
          className="search"
          type="search"
          aria-label="Search history"
          placeholder="Search transcripts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {history.length === 0 ? (
        <p className="empty">
          {settings.keepHistory
            ? 'Nothing here yet. Hold Ctrl+Win and speak.'
            : 'History is off. Turn it on to keep what you dictate.'}
        </p>
      ) : groups.length === 0 ? (
        <p className="empty">Nothing matches “{query.trim()}”.</p>
      ) : (
        groups.map((group) => (
          <div key={group.day} className="day">
            <h2 className="day__label">{group.day}</h2>
            <ul className="history">
              {group.entries.map((entry) => (
                <li key={entry.ts} className="history__item">
                  <div className="history__text">{entry.text}</div>
                  <div className="history__meta">
                    <span>
                      {new Date(entry.ts).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                    <span>{entry.seconds.toFixed(1)} s</span>
                    <button onClick={() => copy(entry)}>
                      {copied === entry.ts ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}

function dayLabel(date: Date): string {
  const today = new Date()
  const key = localDayKey(date)
  if (key === localDayKey(today)) return 'Today'
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (key === localDayKey(yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

/* Stats ---------------------------------------------------------------------- */

function localDayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const RHYTHM_DAYS = 14

function sumDays(stats: Stats, dayKeys: string[]): { takes: number; seconds: number; words: number } {
  let takes = 0
  let seconds = 0
  let words = 0
  for (const key of dayKeys) {
    const day = stats.days[key]
    if (!day) continue
    takes += day.takes
    seconds += day.seconds
    words += day.words
  }
  return { takes, seconds, words }
}

function StatsTab({ stats }: { stats: Stats }): React.JSX.Element {
  const now = new Date()
  const days: { key: string; date: Date }[] = []
  for (let i = RHYTHM_DAYS - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    days.push({ key: localDayKey(date), date })
  }
  const today = sumDays(stats, [days[days.length - 1].key])
  const week = sumDays(
    stats,
    days.slice(-7).map((d) => d.key)
  )
  const most = Math.max(1, ...days.map((d) => stats.days[d.key]?.words ?? 0))

  const figures = [
    { title: 'Today', ...today },
    { title: 'Last 7 days', ...week },
    {
      title: 'All time',
      takes: stats.totalTakes,
      seconds: stats.totalSeconds,
      words: stats.totalWords
    }
  ]

  if (stats.totalTakes === 0) {
    return (
      <section>
        <h1>Stats</h1>
        <p className="empty">Nothing counted yet. Hold Ctrl+Win and speak.</p>
      </section>
    )
  }

  return (
    <section>
      <h1>Stats</h1>
      <div className="card">
        <h2 className="card__title">Words a day, the last two weeks</h2>
        <div
          className="rhythm"
          role="img"
          aria-label={`Words dictated per day over the last ${RHYTHM_DAYS} days`}
        >
          {days.map((d) => {
            const day = stats.days[d.key]
            const words = day?.words ?? 0
            const label = d.date.toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short'
            })
            return (
              <div
                key={d.key}
                className="rhythm__col"
                title={`${label}: ${words} words, ${day?.takes ?? 0} dictations`}
              >
                <div
                  className={`rhythm__bar${words === 0 ? ' rhythm__bar--empty' : ''}`}
                  style={{ height: `${Math.max(4, Math.round((words / most) * 100))}%` }}
                />
              </div>
            )
          })}
        </div>
        <div className="rhythm__axis">
          <span>{days[0].date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
          <span>Today</span>
        </div>
      </div>

      <div className="figures">
        {figures.map((f) => (
          <div key={f.title} className="card figure">
            <h2 className="card__title">{f.title}</h2>
            <div className="figure__words">{f.words.toLocaleString()}</div>
            <div className="figure__unit">words</div>
            <div className="figure__rest">
              {f.takes} {f.takes === 1 ? 'dictation' : 'dictations'}, {(f.seconds / 60).toFixed(1)}{' '}
              min
            </div>
          </div>
        ))}
      </div>
      <p className="muted">Cost lives on the OpenAI usage dashboard. whisp only counts words.</p>
    </section>
  )
}

/* Shared controls ----------------------------------------------------------- */

/**
 * A settings row: name and explanation on the left, the control on the
 * right — or, for controls too wide to share a line, underneath.
 */
function Setting({
  label,
  hint,
  stacked = false,
  children
}: {
  label: string
  hint: string
  stacked?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`setting${stacked ? ' setting--stacked' : ''}`}>
      <div className="setting__text">
        <span className="setting__label">{label}</span>
        <span className="setting__hint">{hint}</span>
      </div>
      <div className="setting__control">{children}</div>
    </div>
  )
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel
}: {
  options: readonly { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
  ariaLabel: string
}): React.JSX.Element {
  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          className={`seg__option${value === o.id ? ' seg__option--active' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className="setting setting--toggle">
      <span className="setting__text">
        <span className="setting__label">{label}</span>
        <span className="setting__hint">{hint}</span>
      </span>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch__track">
          <span className="switch__knob" />
        </span>
      </span>
    </label>
  )
}

/* Rail icons ----------------------------------------------------------------- */

function MicIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <rect x="7" y="2.5" width="6" height="10" rx="3" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6" />
    </svg>
  )
}

function TextIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h7" />
    </svg>
  )
}

function ClockIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.2l2.8 1.6" />
    </svg>
  )
}

function BarsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M4 16.5v-5M10 16.5v-9M16 16.5v-13" />
    </svg>
  )
}
