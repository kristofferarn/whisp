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
    font: 500 12.5px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
    color: #ebeced;
  }
  .pill__body {
    display: flex; align-items: center; gap: 9px;
    padding: 7px 16px 7px 11px; border-radius: 999px;
    background: rgba(16, 16, 17, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
  }
  .error .pill__body {
    background: rgba(44, 19, 16, 0.95);
    border-color: rgba(225, 74, 60, 0.35);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
  }
  #orb { display: block; flex: none; }
  #label { white-space: nowrap; max-width: ${WIDTH - 70}px; overflow: hidden; text-overflow: ellipsis; }
  /* The wave: live mic levels while recording — proof the mic hears you,
     where a static "Listening" only claims it. */
  #bars { display: none; align-items: center; gap: 3.5px; height: 20px; }
  #bars i { width: 3.5px; height: 4px; border-radius: 2px; background: #a9ece5;
            transition: height 70ms linear; }
  .recording #label { display: none; }
  .recording #bars, .handsFree #bars { display: flex; }
  /* Hands-free is the one state that outlives the gesture that started it,
     so it's the one state that says its own name — and tints the lozenge
     teal, the app's "something is live here" color, since this pill may sit
     in the corner of your eye for minutes while you read something else.
     The wave keeps its place beside the wisp; the word goes last. */
  .handsFree #label { order: 1; color: #8fe9de; }
  .handsFree .pill__body { border-color: rgba(69, 224, 210, 0.32); }
</style></head>
<body>
  <div id="pill" class="pill recording"><div class="pill__body">
    <canvas id="orb"></canvas><span id="label">Listening</span>
    <span id="bars"><i></i><i></i><i></i><i></i><i></i></span>
  </div></div>
  <script>
    /* The dot is a wisp: a glowing teal core whose halo swells with the
       voice and breathes softly through silence — alive the whole take,
       never mechanical. Transcribing keeps the slow breath with no voice
       in it; an error dims it to a gray standstill. The bars carry the
       per-band levels, same as ever. */
    var barEls = document.querySelectorAll('#bars i')
    var canvas = document.getElementById('orb')
    var ctx = canvas.getContext('2d')
    var S = 20
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = S * dpr; canvas.height = S * dpr
    canvas.style.width = S + 'px'; canvas.style.height = S + 'px'
    ctx.scale(dpr, dpr)

    var mode = 'recording'
    var target = 0   /* latest peak mic level, 0..1 */
    var energy = 0   /* smoothed toward target — swells fast, settles soft */
    var t = 0

    function live(m) { return m === 'recording' || m === 'handsFree' }
    function setState(m, message) {
      mode = m
      document.getElementById('pill').className = 'pill ' + m
      document.getElementById('label').textContent =
        message || (m === 'handsFree' ? 'Hands-free' : m === 'recording' ? 'Listening' : 'Transcribing')
      if (!live(m)) { target = 0; levels([0, 0, 0, 0, 0]) }
    }
    function levels(bands) {
      var peak = 0
      for (var i = 0; i < barEls.length; i++) {
        var v = Math.max(0, Math.min(1, bands[i] || 0))
        peak = Math.max(peak, v)
        barEls[i].style.height = (4 + v * 14) + 'px'
      }
      target = peak
    }
    function draw() {
      requestAnimationFrame(draw)
      t += 0.016
      energy += (target - energy) * (target > energy ? 0.35 : 0.08)
      ctx.clearRect(0, 0, S, S)
      var c = S / 2
      /* The breath keeps it alive through silence; the voice overrides it. */
      var breath = 0.5 + 0.5 * Math.sin(t * 2.4)
      var glow = mode === 'error' ? 0.25 : 0.3 + breath * 0.15 + energy * 0.55
      var halo = 4.5 + breath * 0.8 + energy * 4.5
      var core = 2.4 + energy * 1.2
      var g = ctx.createRadialGradient(c, c, 0, c, c, halo + core)
      if (mode === 'error') {
        g.addColorStop(0, 'rgba(170, 176, 175, 0.8)')
        g.addColorStop(0.4, 'rgba(150, 158, 157, 0.25)')
        g.addColorStop(1, 'rgba(150, 158, 157, 0)')
      } else {
        g.addColorStop(0, 'rgba(216, 255, 249, 0.95)')
        g.addColorStop(0.28, 'rgba(69, 224, 210, ' + glow + ')')
        g.addColorStop(1, 'rgba(69, 224, 210, 0)')
      }
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(c, c, halo + core, 0, 6.2832)
      ctx.fill()
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

/** Recording, latched hands-free, transcribing — or the one lingering state. */
export type PillMode = 'recording' | 'handsFree' | 'transcribing'

function drive(mode: PillMode | 'error', message?: string): void {
  const win = ensure()
  wantedJs = `setState(${JSON.stringify(mode)}, ${JSON.stringify(message ?? '')})`
  if (pageReady) void win.webContents.executeJavaScript(wantedJs).catch(() => undefined)
  // Wispr's spot: bottom-center of the monitor the cursor is on — dictation
  // follows the pointer, which is the best available guess at where the
  // human is looking. Re-placed at the start of every take, not only on
  // show: consecutive takes can keep the pill visible across a change of
  // monitor, and it should follow. Latching is the exception: a hands-free
  // session is exactly when the pointer wanders, and a pill that chased it
  // would be the one thing in the room that moves while you read.
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
  raise(win)
}

/**
 * Windows strips WS_EX_TOPMOST out from under us — another app going
 * exclusive-fullscreen, a UAC secure desktop, lock/unlock, RDP, an explorer
 * restart — and never gives it back. The pill's window outlives all of those,
 * and showInactive() is SW_SHOWNOACTIVATE, which keeps its z-order rather than
 * raising it, so a single assert at creation meant one demotion hid the pill
 * behind ordinary windows until whisp was restarted. Re-assert every take:
 * off-then-on, because setting a flag Electron already believes is set can
 * no-op before it reaches SetWindowPos.
 */
function raise(win: BrowserWindow): void {
  win.setAlwaysOnTop(false)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
}

export function showPill(mode: PillMode): void {
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
