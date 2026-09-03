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
 *
 * The window is larger than the lozenge: the margin around it is where the
 * glow, the shadow and the entrance ripple live. Windows can't blur the
 * desktop behind a pill-shaped window (acrylic needs the whole rectangle),
 * so the glass here is clear rather than frosted: a light tint, a hairline
 * of light, and the desktop showing through.
 */

const WIDTH = 340
const HEIGHT = 88
/** The lozenge itself, centered in the window. */
const PILL_WIDTH = 260
const PILL_HEIGHT = 44
/** Distance from the work area's bottom edge to the lozenge's bottom edge. */
const MARGIN_BOTTOM = 28
/** How long leave() takes to fade the lozenge out before the window hides. */
const LEAVE_MS = 180

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @property --rim { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
  html, body { margin: 0; background: transparent; overflow: hidden; }
  .stage {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font: 500 12px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
    color: rgba(255, 255, 255, 0.92);
  }
  /* The lozenge blooms in and settles out; a fresh take also sends a ripple
     outward — the moment the mic opens should feel like something began. */
  .pill {
    position: relative;
    width: ${PILL_WIDTH}px; height: ${PILL_HEIGHT}px;
    opacity: 0; transform: translateY(10px) scale(0.94);
    transition: opacity 220ms ease-out, transform 320ms cubic-bezier(0.2, 0.9, 0.3, 1.15);
  }
  .in .pill { opacity: 1; transform: none; }
  .out .pill {
    opacity: 0; transform: translateY(6px) scale(0.97);
    transition: opacity ${LEAVE_MS}ms ease-in, transform ${LEAVE_MS}ms ease-in;
  }
  .ripple {
    position: absolute; inset: 0; border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.7);
    opacity: 0; pointer-events: none;
  }
  .ripple.go { animation: ripple 640ms cubic-bezier(0.2, 0.7, 0.3, 1) forwards; }
  @keyframes ripple {
    0%   { opacity: 0.6; transform: scale(1); }
    100% { opacity: 0; transform: scale(1.2, 1.6); }
  }
  /* Clear glass: a light tint so the line and the word read on anything,
     the desktop visible through it, one hairline of light at the edge. */
  .body {
    position: absolute; inset: 0; border-radius: 999px;
    background: rgba(14, 12, 26, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.32);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22), inset 0 0 24px rgba(255, 255, 255, 0.05);
    transition: background 300ms, border-color 300ms;
  }
  .error .body {
    background: rgba(74, 20, 30, 0.58);
    border-color: rgba(255, 176, 168, 0.5);
  }
  /* A ring of light that circles the lozenge in hands-free — the one state
     that outlives the gesture, so the one that visibly keeps going. Only
     the ring is painted: the mask cuts the middle out so nothing shows
     through the clear body. */
  .rim {
    position: absolute; inset: -1px; border-radius: 999px; padding: 1.5px;
    opacity: 0; transition: opacity 400ms;
    background: conic-gradient(from var(--rim),
      rgba(255,255,255,0) 0deg, rgba(255,255,255,0) 240deg,
      rgba(255, 255, 255, 0.95) 300deg, rgba(255,255,255,0) 360deg);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
    animation: circle 3.6s linear infinite;
  }
  .handsFree .rim { opacity: 1; }
  @keyframes circle { to { --rim: 360deg; } }
  /* The canvas covers the whole body so the line's light is never clipped;
     the string itself is drawn inset from the ends and short of the word. */
  #wave { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  #label {
    position: absolute; right: 18px; top: 50%; transform: translateY(-50%);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: ${PILL_WIDTH - 100}px; letter-spacing: 0.02em;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    opacity: 0; transition: opacity 200ms;
  }
  .labelled #label { opacity: 1; }
  .error #label { color: rgba(255, 228, 224, 0.98); }
</style></head>
<body>
  <div id="stage" class="stage">
    <div id="pill" class="pill">
      <div id="ripple" class="ripple"></div>
      <div class="body"></div>
      <div class="rim"></div>
      <canvas id="wave"></canvas><span id="label"></span>
    </div>
  </div>
  <script>
    /* The breath line: one luminous thread across the glass, pinned at both
       ends like a string. Silence leaves it barely undulating — alive, not
       flat. Voice plucks it: each mic band drives one harmonic, so a low
       voice rolls in long swells and sibilants ripple the surface, and the
       glass lights up behind it. While transcribing the voice is gone and a
       slow wave travels the string instead, carrying a pulse of light; an
       error lets it fall still and turns it warm. */
    var stage = document.getElementById('stage')
    var rippleEl = document.getElementById('ripple')
    var labelEl = document.getElementById('label')
    var canvas = document.getElementById('wave')
    var ctx = canvas.getContext('2d')
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    var cw = 0, ch = 0
    var END = 18           /* where the string is pinned, in from each end */
    var LABEL_GAP = 14     /* space between the string's end and the word */

    var mode = 'hidden'
    var target = [0, 0, 0, 0, 0]  /* latest mic bands, 0..1 */
    var amp = [0, 0, 0, 0, 0]     /* smoothed: swells fast, settles soft */
    var energy = 0                /* overall level, for the light */
    var t = 0

    function live(m) { return m === 'recording' || m === 'handsFree' }
    function setState(m, message) {
      var fresh = mode !== 'recording' && m === 'recording'
      var wasHidden = mode === 'hidden'
      mode = m
      var labelled = m !== 'recording'
      stage.className = 'stage in ' + m + (labelled ? ' labelled' : '')
      labelEl.textContent =
        message || (m === 'handsFree' ? 'Hands-free' : m === 'transcribing' ? 'Transcribing' : '')
      if (!live(m)) levels([0, 0, 0, 0, 0])
      if (fresh) setTimeout(ripple, wasHidden ? 120 : 0)
    }
    function ripple() {
      rippleEl.classList.remove('go')
      void rippleEl.offsetWidth
      rippleEl.classList.add('go')
    }
    /* Fade out; main hides the window once the fade has run. */
    function leave() {
      mode = 'hidden'
      stage.className = 'stage out'
    }
    function levels(bands) {
      for (var i = 0; i < 5; i++) target[i] = Math.max(0, Math.min(1, bands[i] || 0))
    }
    function fit() {
      var w = canvas.clientWidth, h = canvas.clientHeight
      if (w !== cw || h !== ch) {
        cw = w; ch = h
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }
    /* Harmonic k: cycles across the string, how fast its phase drifts, and
       how much of a band it takes to move it. Lower bands move more. */
    var CYCLES = [1, 2, 3.1, 4.4, 6]
    var DRIFT  = [1.3, -1.9, 2.6, -3.4, 4.1]
    var GAIN   = [9, 7, 5, 3.2, 2]

    function draw() {
      requestAnimationFrame(draw)
      if (mode === 'hidden') return
      t += 0.016
      fit()
      if (cw === 0) return
      var peak = 0
      for (var k = 0; k < 5; k++) {
        amp[k] += (target[k] - amp[k]) * (target[k] > amp[k] ? 0.4 : 0.07)
        peak = Math.max(peak, amp[k])
      }
      energy += (peak - energy) * (peak > energy ? 0.3 : 0.06)
      ctx.clearRect(0, 0, cw, ch)

      var labelled = mode !== 'recording'
      var x0 = END
      var x1 = cw - END - (labelled ? labelEl.offsetWidth + LABEL_GAP : 0)
      var span = Math.max(40, x1 - x0)
      var mid = ch / 2
      var breath = 0.5 + 0.5 * Math.sin(t * 1.6)
      var isLive = live(mode)
      var still = mode === 'error'
      var pulseU = -0.25 + ((t * 0.45) % 1.5)   /* the transcribing light, 0..1 along the string */

      /* The light in the glass: the voice lights the pane behind the string. */
      if (isLive && energy > 0.02) {
        var lg = ctx.createRadialGradient(x0 + span / 2, mid, 0, x0 + span / 2, mid, span * 0.55)
        lg.addColorStop(0, 'rgba(210, 200, 255, ' + (energy * 0.34) + ')')
        lg.addColorStop(1, 'rgba(210, 200, 255, 0)')
        ctx.fillStyle = lg
        ctx.fillRect(0, 0, cw, ch)
      }

      /* Two strokes: a soft wide halo, then the thread. */
      var N = Math.max(24, Math.floor(span / 3))
      for (var pass = 0; pass < 2; pass++) {
        ctx.beginPath()
        for (var i = 0; i <= N; i++) {
          var u = i / N
          var env = Math.pow(Math.sin(Math.PI * u), 0.85)
          var y = 0
          if (!still) {
            y += Math.sin(u * 6.2832 + t * 1.1) * (0.5 + breath * 0.6)   /* the breath */
            if (isLive) {
              for (var k2 = 0; k2 < 5; k2++) {
                y += Math.sin(u * 6.2832 * CYCLES[k2] + t * DRIFT[k2]) * amp[k2] * GAIN[k2]
              }
            } else {
              y += Math.sin(u * 6.2832 * 1.5 - t * 2.2) * 3.2             /* the travelling wave */
              var d = (u - pulseU) / 0.1
              y += Math.exp(-d * d) * 2.5 * Math.sin(u * 6.2832 * 4 + t * 5)
            }
          }
          var px = x0 + u * span
          var py = mid + y * env
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
        }
        ctx.lineCap = 'round'
        if (pass === 0) {
          ctx.lineWidth = 9
          ctx.strokeStyle = still
            ? 'rgba(255, 150, 140, 0.16)'
            : 'rgba(200, 192, 255, ' + (0.12 + energy * 0.45) + ')'
        } else {
          ctx.lineWidth = 1.7
          ctx.strokeStyle = still
            ? 'rgba(255, 200, 192, 0.9)'
            : 'rgba(255, 255, 255, ' + (0.8 + energy * 0.2) + ')'
        }
        ctx.stroke()
      }
      /* The transcribing pulse carries its own light along the thread. */
      if (!isLive && !still) {
        var px2 = x0 + pulseU * span
        var g = ctx.createRadialGradient(px2, mid, 0, px2, mid, 30)
        g.addColorStop(0, 'rgba(230, 224, 255, 0.5)')
        g.addColorStop(1, 'rgba(230, 224, 255, 0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, cw, ch)
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
/** A hide in progress (the fade-out), cancelled by any state that shows. */
let leaving: NodeJS.Timeout | null = null

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
  if (leaving) {
    clearTimeout(leaving)
    leaving = null
  }
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
    const inset = (HEIGHT - PILL_HEIGHT) / 2
    win.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + height - HEIGHT + inset - MARGIN_BOTTOM),
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

/**
 * Fades the lozenge, then hides the window. A show arriving mid-fade cancels
 * the hide and the page's setState brings the lozenge straight back.
 */
export function hidePill(): void {
  if (!pill || pill.isDestroyed() || !pill.isVisible() || leaving) return
  const win = pill
  if (pageReady) void win.webContents.executeJavaScript('leave()').catch(() => undefined)
  leaving = setTimeout(() => {
    leaving = null
    if (!win.isDestroyed() && win.isVisible()) win.hide()
  }, LEAVE_MS)
}

export function destroyPill(): void {
  if (leaving) {
    clearTimeout(leaving)
    leaving = null
  }
  if (pill && !pill.isDestroyed()) pill.destroy()
  pill = null
}
