import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { setTrayUpdateReady } from './tray'

/**
 * Auto-update, tray-app shaped. whisp runs for weeks between restarts, so a
 * launch-time check alone would never fire: it checks on boot and then every
 * six hours, downloads in the background, and — instead of restarting an app
 * that might be mid-dictation — surfaces a "Restart to update" item in the
 * tray menu. Quitting normally also installs (autoInstallOnAppQuit), so an
 * update can never be dodged forever by simply never clicking it.
 *
 * The feed comes from electron-builder's publish block (app-update.yml in
 * the installed build); the repo is public, so polling needs no token.
 * Dev builds have no app-update.yml and skip all of this.
 */

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export function initUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    setTrayUpdateReady(info.version, () => autoUpdater.quitAndInstall())
  })
  // A failed check is a non-event: the next interval retries, and a tray
  // utility has no better surface for "GitHub was briefly unreachable".
  autoUpdater.on('error', (err) => {
    console.error('whisp updater:', err instanceof Error ? err.message : err)
  })

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => undefined)
  }
  check()
  setInterval(check, CHECK_EVERY_MS).unref()
}
