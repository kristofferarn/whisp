import { useCallback, useEffect, useState } from 'react'
import type { HistoryEntry, KeyStatus, Stats, WhispSettings } from '../../../shared/ipc'

/**
 * The settings window — whisp's whole visible surface. Four tabs over the
 * same small data set: the key and toggles (General), the vocabulary prompt
 * (Dictionary), recent transcripts (History), and the tally (Stats). All of
 * it re-fetches on main's dataChanged push, so a dictation landing while
 * the window is open updates History and Stats live.
 */

type Tab = 'general' | 'dictionary' | 'history' | 'stats'

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'dictionary', label: 'Dictionary' },
  { id: 'history', label: 'History' },
  { id: 'stats', label: 'Stats' }
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
  const [tab, setTab] = useState<Tab>('general')
  const [data, setData] = useState<Data | null>(null)

  const refresh = useCallback(() => {
    void fetchAll().then(setData)
  }, [])

  useEffect(() => {
    refresh()
    return window.whisp.onDataChanged(refresh)
  }, [refresh])

  if (!data) return <div className="app" />

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand__dot" />
          whisp
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`sidebar__item${tab === t.id ? ' sidebar__item--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="sidebar__hint">
          Hold <kbd>Ctrl</kbd>+<kbd>Win</kbd> anywhere, speak, release.
        </div>
      </nav>
      <main className="content">
        {tab === 'general' && <General data={data} refresh={refresh} />}
        {tab === 'dictionary' && <Dictionary data={data} />}
        {tab === 'history' && <History data={data} />}
        {tab === 'stats' && <StatsTab stats={data.stats} />}
      </main>
    </div>
  )
}

/* General ------------------------------------------------------------- */

function General({ data, refresh }: { data: Data; refresh: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const { key, settings } = data

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
    <section>
      <h1>General</h1>

      <div className="card">
        <h2>OpenAI API key</h2>
        <p className="muted">
          Dictation transcribes over the OpenAI API (gpt-4o-mini-transcribe, ~$0.003 per minute of
          speech). The key is stored encrypted on this machine and never leaves the main process.
        </p>
        <div className="row">
          <input
            type="password"
            placeholder={key.configured ? `Configured — ends in …${key.last4}` : 'sk-…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey()
            }}
          />
          <button className="primary" disabled={!draft.trim() || busy} onClick={() => void saveKey()}>
            Save
          </button>
          {key.configured && (
            <button disabled={busy} onClick={() => void clearKey()}>
              Clear
            </button>
          )}
        </div>
        <p className={key.configured ? 'status status--ok' : 'status status--warn'}>
          {key.configured ? `Key configured (…${key.last4})` : 'No key yet — dictation is inert until one is saved.'}
        </p>
      </div>

      <div className="card">
        <h2>Behavior</h2>
        <Toggle
          label="Mic-ready tick"
          hint="A near-subliminal chirp when the microphone is actually capturing — words spoken before it are lost."
          checked={settings.chime}
          onChange={(v) => void window.whisp.settings.set({ chime: v })}
        />
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
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="toggle__label">{label}</span>
        <span className="toggle__hint">{hint}</span>
      </span>
    </label>
  )
}

/* Dictionary ----------------------------------------------------------- */

function Dictionary({ data }: { data: Data }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const words = data.settings.dictionary

  const add = (): void => {
    const fresh = draft
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
    if (fresh.length === 0) return
    void window.whisp.settings.set({ dictionary: [...words, ...fresh] })
    setDraft('')
  }

  const remove = (word: string): void => {
    void window.whisp.settings.set({ dictionary: words.filter((w) => w !== word) })
  }

  return (
    <section>
      <h1>Dictionary</h1>
      <p className="muted">
        Names and jargon the transcriber would otherwise mishear — they ride every request as a
        spelling hint. Product names, coworkers, project words: “whisp”, “SPCE”, “koffi”…
      </p>
      <div className="row">
        <input
          placeholder="Add a word (comma-separate several)"
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
        <p className="empty">Nothing yet. Dictation works without it — this just sharpens spelling.</p>
      ) : (
        <div className="chips">
          {words.map((word) => (
            <span key={word} className="chip">
              {word}
              <button className="chip__x" title="Remove" onClick={() => remove(word)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

/* History --------------------------------------------------------------- */

function History({ data }: { data: Data }): React.JSX.Element {
  const [copied, setCopied] = useState<number | null>(null)
  const { history, settings } = data

  const copy = (entry: HistoryEntry): void => {
    void navigator.clipboard.writeText(entry.text).then(() => {
      setCopied(entry.ts)
      setTimeout(() => setCopied(null), 1200)
    })
  }

  return (
    <section>
      <div className="section-head">
        <h1>History</h1>
        {history.length > 0 && (
          <button onClick={() => void window.whisp.history.clear()}>Clear all</button>
        )}
      </div>
      <Toggle
        label="Keep history"
        hint="Store recent transcripts locally (last 500). Turning this off also deletes what's here."
        checked={settings.keepHistory}
        onChange={(v) => void window.whisp.settings.set({ keepHistory: v })}
      />
      {history.length === 0 ? (
        <p className="empty">
          {settings.keepHistory ? 'No dictations yet.' : 'History is off.'}
        </p>
      ) : (
        <ul className="history">
          {history.map((entry) => (
            <li key={entry.ts} className="history__item">
              <div className="history__meta">
                <span>{new Date(entry.ts).toLocaleString()}</span>
                <span>{entry.seconds.toFixed(1)}s</span>
                <button onClick={() => copy(entry)}>{copied === entry.ts ? 'Copied' : 'Copy'}</button>
              </div>
              <div className="history__text">{entry.text}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* Stats ------------------------------------------------------------------ */

const USD_PER_SECOND = 0.003 / 60

function localDayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatUsd(usd: number): string {
  const dollars = usd.toFixed(2)
  if (usd > 0 && dollars === '0.00') return '<$0.01'
  return `$${dollars}`
}

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
  const todayKey = localDayKey(now)
  const weekKeys: string[] = []
  for (let i = 0; i < 7; i++) {
    weekKeys.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
  }

  const today = sumDays(stats, [todayKey])
  const week = sumDays(stats, weekKeys)
  const cards = [
    { title: 'Today', ...today, cost: today.seconds * USD_PER_SECOND },
    { title: 'Last 7 days', ...week, cost: week.seconds * USD_PER_SECOND },
    {
      title: 'All time',
      takes: stats.totalTakes,
      seconds: stats.totalSeconds,
      words: stats.totalWords,
      cost: stats.totalCostUsd
    }
  ]

  return (
    <section>
      <h1>Stats</h1>
      <div className="stat-cards">
        {cards.map((card) => (
          <div key={card.title} className="card stat-card">
            <h2>{card.title}</h2>
            <dl>
              <div>
                <dt>Dictations</dt>
                <dd>{card.takes}</dd>
              </div>
              <div>
                <dt>Minutes</dt>
                <dd>{(card.seconds / 60).toFixed(1)}</dd>
              </div>
              <div>
                <dt>Words</dt>
                <dd>{card.words}</dd>
              </div>
              <div>
                <dt>Est. cost</dt>
                <dd>{card.cost === 0 ? '$0.00' : formatUsd(card.cost)}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
      <p className="muted">
        Priced by recorded duration at gpt-4o-mini-transcribe's ~$0.003/minute — an estimate, not a
        bill.
      </p>
    </section>
  )
}
