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
 * glow, the shadow and the entrance ripple live. A transparent window can't
 * blur the desktop behind it, so the glass is painted, not sampled.
 */

const WIDTH = 320
const HEIGHT = 84
/** The lozenge itself, centered in the window. */
const PILL_WIDTH = 240
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
    font: 500 12.5px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
    color: rgba(240, 240, 250, 0.92);
  }
  /* The lozenge blooms in and settles out; a fresh take also sends a ripple
     outward — the moment the mic opens should feel like something began. */
  .pill {
    position: relative;
    width: ${PILL_WIDTH}px; height: ${PILL_HEIGHT}px;
    opacity: 0; transform: translateY(10px) scale(0.92);
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
    100% { opacity: 0; transform: scale(1.22, 1.6); }
  }
  /* A one-pixel rim of light behind the body. It circles slowly in
     hands-free — the one state that outlives the gesture, so the one that
     visibly keeps going. */
  .rim {
    position: absolute; inset: -1px; border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
    transition: background 300ms;
  }
  .handsFree .rim {
    background: conic-gradient(from var(--rim),
      rgba(255,255,255,0.12) 0deg, rgba(255,255,255,0.12) 250deg,
      rgba(230, 226, 255, 0.95) 300deg, rgba(255,255,255,0.12) 350deg);
    animation: circle 3.6s linear infinite;
  }
  @keyframes circle { to { --rim: 360deg; } }
  .error .rim { background: rgba(255, 170, 160, 0.4); }
  .body {
    position: absolute; inset: 0; border-radius: 999px;
    display: flex; align-items: center; gap: 10px;
    padding: 0 18px;
    background: linear-gradient(180deg, rgba(48, 44, 96, 0.9), rgba(24, 22, 56, 0.94));
    box-shadow:
      0 12px 32px rgba(18, 16, 48, 0.42),
      0 2px 6px rgba(18, 16, 48, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.22);
    transition: background 300ms;
  }
  /* The glint: light catching the top of the glass. */
  .body::before {
    content: ''; position: absolute; inset: 1px 14px auto 14px; height: 45%;
    border-radius: 999px 999px 40% 40%;
    background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0));
    pointer-events: none;
  }
  .error .body {
    background: linear-gradient(180deg, rgba(104, 40, 52, 0.92), rgba(62, 22, 32, 0.95));
  }
  #wave { display: block; flex: 1; height: 28px; min-width: 0; transition: flex-basis 220ms ease; }
  #label {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: ${PILL_WIDTH - 110}px; letter-spacing: 0.01em;
    opacity: 0; transition: opacity 200ms;
  }
  /* While recording the line is the whole message; the word appears only
     when the line alone can't say what's happening. */
  .recording #label { display: none; }
  .labelled #label { opacity: 1; }
  .labelled #wave { flex: 0 0 76px; }
  .handsFree #label { color: rgba(236, 233, 255, 0.98); }
  .transcribing #label { color: rgba(220, 216, 245, 0.8); }
  .error #label { color: rgba(255, 226, 220, 0.96); }
</style></head>
<body>
  <div id="stage" class="stage">
    <div id="pill" class="pill">
      <div id="ripple" class="ripple"></div>
      <div class="rim"></div>
      <div class="body"><canvas id="wave"></canvas><span id="label"></span></div>
    </div>
  </div>
  <script>
    /* The breath line: one luminous thread across the glass, pinned at both
       ends like a string. Silence leaves it barely undulating — alive, not
       flat. Voice plucks it: each mic band drives one harmonic, so a low
       voice rolls in long swells and sibilants ripple the surface. While
       transcribing the voice is gone and a single pulse of light travels the
       string instead; an error lets it fall still and turns it warm. */
    var stage = document.getElementById('stage')
    var pillEl = document.getElementById('pill')
    var rippleEl = document.getElementById('ripple')
    var labelEl = document.getElementById('label')
    var canvas = document.getElementById('wave')
    var ctx = canvas.getContext('2d')
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    var cw = 0, ch = 0

    var mode = 'hidden'
    var target = [0, 0, 0, 0, 0]  /* latest mic bands, 0..1 */
    var amp = [0, 0, 0, 0, 0]     /* smoothed: swells fast, settles soft */
    var energy = 0                /* overall level, for the glow */
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
      if (!live(m)) { levels([0, 0, 0, 0, 0]) }
      if (fresh && !wasHidden) ripple()
      if (fresh && wasHidden) setTimeout(ripple, 120)
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
    var GAIN   = [7, 5.5, 4, 2.6, 1.6]

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

      var mid = ch / 2
      var breath = 0.5 + 0.5 * Math.sin(t * 1.6)
      var isLive = live(mode)
      var still = mode === 'error'
      var pulseX = -0.2 + ((t * 0.55) % 1.5)   /* the transcribing light, in 0..1 of width */

      /* Two strokes: a soft wide halo colored by the voice, then the thread. */
      for (var pass = 0; pass < 2; pass++) {
        ctx.beginPath()
        var N = Math.max(24, Math.floor(cw / 3))
        for (var i = 0; i <= N; i++) {
          var u = i / N
          var x = u * cw
          var env = Math.pow(Math.sin(Math.PI * u), 0.85)
          var y = 0
          if (!still) {
            y += Math.sin(u * 6.2832 * 1.0 + t * 1.1) * (0.45 + breath * 0.5)  /* the breath */
            if (isLive) {
              for (var k = 0; k < 5; k++) {
                y += Math.sin(u * 6.2832 * CYCLES[k] + t * DRIFT[k]) * amp[k] * GAIN[k]
              }
            } else {
              var d = (u - pulseX) / 0.09
              y += Math.exp(-d * d) * 3.2 * Math.sin(u * 6.2832 * 3 + t * 4)
            }
          }
          var py = mid + y * env
          if (i === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py)
        }
        if (pass === 0) {
          ctx.lineWidth = 7
          ctx.strokeStyle = still
            ? 'rgba(255, 150, 140, 0.18)'
            : 'rgba(186, 178, 255, ' + (0.1 + energy * 0.5) + ')'
        } else {
          ctx.lineWidth = 1.6
          ctx.lineCap = 'round'
          ctx.strokeStyle = still
            ? 'rgba(255, 196, 188, 0.85)'
            : 'rgba(255, 255, 255, ' + (0.72 + energy * 0.28) + ')'
        }
        ctx.stroke()
      }
      /* The transcribing pulse carries its own light along the thread. */
      if (!isLive && !still) {
        var g = ctx.createRadialGradient(pulseX * cw, mid, 0, pulseX * cw, mid, 26)
        g.addColorStop(0, 'rgba(226, 220, 255, 0.55)')
        g.addColorStop(1, 'rgba(226, 220, 255, 0)')
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
