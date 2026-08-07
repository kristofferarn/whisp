import { BrowserWindow, screen } from 'electron'

/**
 * The dictation pill — whisp's only in-flow UI: a small always-on-top
 * lozenge at the bottom-center of whichever monitor the cursor is on. It
 * appears when a take starts and vanishes when the last one resolves; the
 * pasted text is its own success signal, so 'done' has no state — only
 * errors linger for a moment to say why nothing appeared.
 *
 * Three properties are load-bearing, not cosmetic:
 *  - `focusable: false` + showInactive(): the pill must never take focus,
 *    because the paste goes to whatever is focused.
 *  - setIgnoreMouseEvents: click-through, so it can't intercept a click
 *    meant for what's behind it.
 *  - Content is one inline data-URL page with no preload and no IPC surface;
 *    main drives it with executeJavaScript. Nothing to bundle, nothing to
 *    secure beyond an inert div.
 */

const WIDTH = 240
const HEIGHT = 48
const MARGIN_BOTTOM = 28

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  .pill {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center; gap: 9px;
    font: 500 12.5px system-ui, sans-serif; color: #f2ede6;
  }
  .pill__body {
    display: flex; align-items: center; gap: 9px;
    padding: 9px 16px; border-radius: 999px;
    background: rgba(24, 21, 18, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .recording .dot { background: #e14a3c; animation: pulse 1.1s ease-in-out infinite; }
  .transcribing .dot { background: #d8a542; animation: spin-blink 0.9s ease-in-out infinite; }
  .error .dot { background: #8a8378; }
  .error .pill__body { background: rgba(52, 26, 22, 0.95); }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.45); opacity: 0.65; }
  }
  @keyframes spin-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  #label { white-space: nowrap; max-width: ${WIDTH - 60}px; overflow: hidden; text-overflow: ellipsis; }
  /* The wave: live mic levels while recording — proof the mic hears you,
     where a static "Listening" only claims it. */
  #bars { display: none; align-items: center; gap: 3.5px; height: 20px; }
  #bars i { width: 3.5px; height: 4px; border-radius: 2px; background: #f2ede6;
            transition: height 70ms linear; }
  .recording #label { display: none; }
  .recording #bars { display: flex; }
</style></head>
<body>
  <div id="pill" class="pill recording"><div class="pill__body">
    <span class="dot"></span><span id="label">Listening</span>
    <span id="bars"><i></i><i></i><i></i><i></i><i></i></span>
  </div></div>
  <script>
    var barEls = document.querySelectorAll('#bars i')
    function setState(mode, message) {
      document.getElementById('pill').className = 'pill ' + mode
      document.getElementById('label').textContent =
        message || (mode === 'recording' ? 'Listening' : 'Transcribing')
      if (mode !== 'recording') levels([0, 0, 0, 0, 0])
    }
    function levels(bands) {
      for (var i = 0; i < barEls.length; i++) {
        var v = Math.max(0, Math.min(1, bands[i] || 0))
        barEls[i].style.height = (4 + v * 14) + 'px'
      }
    }
  </script>
</body></html>`

let pill: BrowserWindow | null = null
/** The page is a data URL that loads async; state pushed before it finishes
 *  would vanish into the void, so the latest wanted state is kept and
 *  replayed the moment the page reports in. */
let pageReady = false
let wantedJs: string | null = null

function ensure(): BrowserWindow {
  if (pill && !pill.isDestroyed()) return pill
  pageReady = false
  pill = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { sandbox: true }
  })
  pill.setAlwaysOnTop(true, 'screen-saver')
  pill.setIgnoreMouseEvents(true)
  pill.webContents.once('did-finish-load', () => {
    pageReady = true
    if (wantedJs) void pill?.webContents.executeJavaScript(wantedJs).catch(() => undefined)
  })
  void pill.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  return pill
}

/** Creates the hidden window up front so the first show has no build latency. */
export function initPill(): void {
  ensure()
}

function drive(mode: 'recording' | 'transcribing' | 'error', message?: string): void {
  const win = ensure()
  wantedJs = `setState(${JSON.stringify(mode)}, ${JSON.stringify(message ?? '')})`
  if (pageReady) void win.webContents.executeJavaScript(wantedJs).catch(() => undefined)
  // Wispr's spot: bottom-center of the monitor the cursor is on — dictation
  // follows the pointer, which is the best available guess at where the
  // human is looking. Re-placed at the start of every take, not only on
  // show: consecutive takes can keep the pill visible across a change of
  // monitor, and it should follow.
  if (!win.isVisible() || mode === 'recording') {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { x, y, width, height } = display.workArea
    win.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + height - HEIGHT - MARGIN_BOTTOM),
      width: WIDTH,
      height: HEIGHT
    })
  }
  if (!win.isVisible()) win.showInactive()
}

export function showPill(mode: 'recording' | 'transcribing'): void {
  drive(mode)
}

/**
 * One frame of the wave. Fire-and-forget on purpose: a frame that races the
 * page load or a hidden pill is just dropped — the next one is 50ms away.
 */
export function pillLevels(bands: number[]): void {
  if (!pill || pill.isDestroyed() || !pageReady || !pill.isVisible()) return
  const safe = bands.slice(0, 8).map((v) => (Number.isFinite(v) ? v : 0))
  void pill.webContents.executeJavaScript(`levels(${JSON.stringify(safe)})`).catch(() => undefined)
}

/** Errors are the one state that lingers: the caller re-asserts (or hides)
 *  after the flash, so a new take starting mid-flash simply wins. */
export function flashPillError(message: string, after: () => void): void {
  drive('error', message)
  setTimeout(after, 2500)
}

export function hidePill(): void {
  if (pill && !pill.isDestroyed() && pill.isVisible()) pill.hide()
}

export function destroyPill(): void {
  if (pill && !pill.isDestroyed()) pill.destroy()
  pill = null
}
