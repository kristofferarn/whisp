import { useEffect, useState } from 'react'
import logoUrl from '../../../../resources/logo-128.png'

/**
 * The frameless window's own title bar: the mark and the name at the left,
 * Windows-style minimize / maximize / close at the right, and the whole strip
 * a drag handle. The buttons opt out of dragging or they'd never get the
 * click. The mark flares when a dictation lands.
 */
export function TitleBar({ flare }: { flare: boolean }): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => window.whisp.window.onMaximized(setMaximized), [])

  return (
    <header className="titlebar">
      <img
        className={`titlebar__mark${flare ? ' titlebar__mark--flare' : ''}`}
        src={logoUrl}
        alt=""
        width={18}
        height={18}
      />
      <span className="titlebar__name">whisp</span>
      <div className="titlebar__controls">
        <button aria-label="Minimize" onClick={() => window.whisp.window.control('minimize')}>
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <path d="M0 5h10" />
          </svg>
        </button>
        <button
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => window.whisp.window.control('maximize')}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <path d="M2.5 2.5V.5h7v7h-2" />
              <rect x="0.5" y="2.5" width="7" height="7" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
        <button
          className="titlebar__close"
          aria-label="Close"
          onClick={() => window.whisp.window.control('close')}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" />
          </svg>
        </button>
      </div>
    </header>
  )
}
