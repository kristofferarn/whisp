import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'

/**
 * whisp's two real windows (the pill is pill.ts's own):
 *
 * - The capture window: hidden, never shown, exists because getUserMedia
 *   lives in a renderer. It is the microphone and nothing else — the
 *   settings window can open, close and crash without touching it, which is
 *   what keeps a recording in flight safe from the UI.
 * - The settings window: the visible app — key, dictionary, history, stats.
 *   Opens from the tray, closes for real; the tray keeps the app alive.
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
    width: 780,
    height: 580,
    minWidth: 640,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: '#121214',
    icon: appIcon,
    webPreferences: { preload: preloadPath }
  })
  settingsWin.on('closed', () => {
    settingsWin = null
  })
  // External links (none today, but any future "get an API key" link) open
  // in the browser, never inside the settings window.
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadPage(settingsWin, 'settings.html')
  return settingsWin
}

export function settingsWindow(): BrowserWindow | null {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null
}
