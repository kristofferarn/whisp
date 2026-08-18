import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { initAudioControl, stopAudioControl } from './audio-control'
import { initDictation, stopDictation } from './dictation'
import { keyStatus, registerKeyHandlers } from './keystore'
import { destroyPill } from './pill'
import { getSettings, initStore, registerStoreHandlers, setStoreListener } from './store'
import { initTray } from './tray'
import { initUpdater } from './updater'
import { createCaptureWindow, openSettingsWindow, settingsWindow } from './windows'

/**
 * whisp — system-wide push-to-talk dictation for Windows.
 *
 * Boot order matters only a little: the store first (dictation reads the
 * dictionary from it), then the hidden capture window (the microphone),
 * then dictation itself and the tray. The settings window only opens when
 * asked — or on first run, when there is no API key and nothing works yet.
 */

// Dev and installed builds keep separate worlds: settings, key, history —
// and, critically, the single-instance lock, which is scoped to userData.
// Without this split a dev run can't even start while the installed app is
// running; with it they coexist (mute one from its tray, the hotkey poll
// isn't exclusive). Must happen before the lock is requested.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'whisp-dev'))
}

// One whisp per world owns its lock. A second launch just surfaces the
// first one's settings window — two instances in the same world would both
// fire on every press and paste everything twice.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    openSettingsWindow()
  })

  app.whenReady().then(async () => {
    initStore()
    initAudioControl(getSettings().audioBehavior)
    registerKeyHandlers(ipcMain)
    registerStoreHandlers(ipcMain)
    // Anything the settings UI shows changed — tell it, if it's open.
    setStoreListener(() => {
      initAudioControl(getSettings().audioBehavior)
      settingsWindow()?.webContents.send(IPC.dataChanged)
    })

    const capture = createCaptureWindow()
    initDictation(ipcMain, capture.webContents)
    initTray(() => openSettingsWindow())
    initUpdater()

    // First run: no key means nothing works — open the one place to fix it.
    const status = await keyStatus()
    if (!status.configured) openSettingsWindow()
  })

  // The app lives in the tray; the settings window closing must not end it.
  app.on('window-all-closed', () => {
    /* stay resident */
  })

  app.on('before-quit', () => {
    stopDictation()
    stopAudioControl()
    destroyPill()
  })
}
