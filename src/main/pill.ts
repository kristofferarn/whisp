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
    display: flex; align-items: center; justify-content: center;
    font: 500 12.5px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
    color: #e8f4f2;
  }
  .pill__body {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 15px 6px 7px; border-radius: 999px;
    background: rgba(10, 15, 16, 0.92);
    border: 1px solid rgba(69, 224, 210, 0.20);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45), 0 0 22px rgba(69, 224, 210, 0.10);
  }
  .error .pill__body {
    background: rgba(44, 19, 16, 0.95);
    border-color: rgba(225, 74, 60, 0.35);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
  }
  #label { white-space: nowrap; max-width: ${WIDTH - 70}px; overflow: hidden; text-overflow: ellipsis; }
  #orb { display: block; flex: none; }
</style></head>
<body>
  <div id="pill" class="pill recording"><div class="pill__body">
    <canvas id="orb"></canvas><span id="label">Listening</span>
  </div></div>
  <script>
    /* The wisp itself — three orbs circling, drawn live. While recording its
       spin, glow and orbit swell with the real mic levels: proof the mic
       hears you, where a static "Listening" only claims it (the same honest
       job the old wave bars did). Transcribing is a calm steady drift;
       an error freezes it gray. */
    var canvas = document.getElementById('orb')
    var ctx = canvas.getContext('2d')
    var S = 32
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = S * dpr; canvas.height = S * dpr
    canvas.style.width = S + 'px'; canvas.style.height = S + 'px'
    ctx.scale(dpr, dpr)

    var mode = 'recording'
    var target = 0   /* latest mic level, 0..1 */
    var energy = 0   /* smoothed toward target — no jitter, no lag worth naming */
    var angle = 0

    function setState(m, message) {
      mode = m
      document.getElementById('pill').className = 'pill ' + m
      document.getElementById('label').textContent =
        message || (m === 'recording' ? 'Listening' : 'Transcribing')
      if (m !== 'recording') target = 0
    }
    function levels(bands) {
      var peak = 0
      for (var i = 0; i < bands.length; i++) peak = Math.max(peak, bands[i] || 0)
      target = Math.max(0, Math.min(1, peak))
    }
    function dot(x, y, r, alpha) {
      var reach = r * 2.6
      var g = ctx.createRadialGradient(x, y, 0, x, y, reach)
      if (mode === 'error') {
        g.addColorStop(0, 'rgba(150, 158, 157, ' + alpha + ')')
        g.addColorStop(1, 'rgba(150, 158, 157, 0)')
      } else {
        g.addColorStop(0, 'rgba(216, 255, 249, ' + alpha + ')')
        g.addColorStop(0.4, 'rgba(69, 224, 210, ' + alpha * 0.75 + ')')
        g.addColorStop(1, 'rgba(69, 224, 210, 0)')
      }
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, reach, 0, 6.2832)
      ctx.fill()
    }
    function draw() {
      requestAnimationFrame(draw)
      var goal = mode === 'recording' ? target : mode === 'transcribing' ? 0.22 : 0
      energy += (goal - energy) * 0.15
      if (mode !== 'error') angle += 0.02 + energy * 0.11
      ctx.clearRect(0, 0, S, S)
      var R = 8 + energy * 3
      for (var i = 0; i < 3; i++) {
        var a = angle + i * 2.0944
        for (var k = 4; k >= 1; k--) {
          var ta = a - k * 0.17
          dot(16 + Math.cos(ta) * R, 16 + Math.sin(ta) * R, 1.8,
              0.12 * (5 - k) / 5 * (0.4 + energy))
        }
        dot(16 + Math.cos(a) * R, 16 + Math.sin(a) * R, 2.6 + energy * 1.4, 0.9)
      }
    }
    draw()
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
