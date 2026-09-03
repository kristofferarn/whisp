import { join } from 'node:path'
import { BrowserWindow, shell, type IpcMain } from 'electron'
import { IPC, type WindowControl } from '../shared/ipc'

/**
 * whisp's two real windows (the pill is pill.ts's own):
 *
 * - The capture window: hidden, never shown, exists because getUserMedia
 *   lives in a renderer. It is the microphone and nothing else — the
 *   settings window can open, close and crash without touching it, which is
 *   what keeps a recording in flight safe from the UI.
 * - The settings window: the visible app — one sheet of glass. Windows 11
 *   acrylic blurs the desktop through it, which only works on a frameless
 *   window (Electron treats material + frame as opaque), so the page draws
 *   its own title bar and window buttons. Opens from the tray, closes for
 *   real; the tray keeps the app alive.
 */

import appIcon from '../../resources/whisp.ico?asset'

const preloadPath = join(__dirname, '../preload/index.js')

function loadPage(win: BrowserWindow, page: string): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) void win.loadURL(`${devServer}/${page}`)
  else void win.loadFile(join(__dirname, `../renderer/${page}`))
}

export function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    skipTaskbar: true,
    webPreferences: { preload: preloadPath }
  })
  loadPage(win, 'index.html')
  return win
}

let settingsWin: BrowserWindow | null = null

export function openSettingsWindow(): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    return settingsWin
  }
  settingsWin = new BrowserWindow({
    width: 820,
    height: 600,
    minWidth: 660,
    minHeight: 480,
    frame: false,
    // Acrylic: the desktop, blurred, is the window's background. Electron
    // makes the page transparent itself when a material is set on a
    // frameless window, so no backgroundColor here — one would paint over it.
    // Below Windows 11 22H2 the material is ignored and the page's own dark
    // tint is what shows.
    backgroundMaterial: 'acrylic',
    icon: appIcon,
    webPreferences: { preload: preloadPath }
  })
  const win = settingsWin
  win.on('closed', () => {
    settingsWin = null
  })
  const tellMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.windowMaximized, win.isMaximized())
  }
  win.on('maximize', tellMaximized)
  win.on('unmaximize', tellMaximized)
  // External links (none today, but any future "get an API key" link) open
  // in the browser, never inside the settings window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadPage(win, 'settings.html')
  return win
}

export function settingsWindow(): BrowserWindow | null {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null
}

/** The title-bar buttons the frameless settings window draws for itself. */
export function registerWindowControls(ipc: IpcMain): void {
  ipc.on(IPC.windowControl, (event, action: WindowControl) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== settingsWin) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })
}
