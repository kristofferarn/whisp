import { app, ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { initDictation, stopDictation } from './dictation'
import { keyStatus, registerKeyHandlers } from './keystore'
import { destroyPill } from './pill'
import { initStore, registerStoreHandlers, setStoreListener } from './store'
import { initTray } from './tray'
import { createCaptureWindow, openSettingsWindow, settingsWindow } from './windows'

/**
 * whisp — system-wide push-to-talk dictation for Windows.
 *
 * Boot order matters only a little: the store first (dictation reads the
 * dictionary from it), then the hidden capture window (the microphone),
 * then dictation itself and the tray. The settings window only opens when
 * asked — or on first run, when there is no API key and nothing works yet.
 */

// One whisp owns the hotkey. A second launch just surfaces the first one's
// settings window — the poll isn't an exclusive registration, so two
// instances would both fire on every press and paste everything twice.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    openSettingsWindow()
  })

  app.whenReady().then(async () => {
    initStore()
    registerKeyHandlers(ipcMain)
    registerStoreHandlers(ipcMain)
    // Anything the settings UI shows changed — tell it, if it's open.
    setStoreListener(() => {
      settingsWindow()?.webContents.send(IPC.dataChanged)
    })

    const capture = createCaptureWindow()
    initDictation(ipcMain, capture.webContents)
    initTray(() => openSettingsWindow())

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
    destroyPill()
  })
}
