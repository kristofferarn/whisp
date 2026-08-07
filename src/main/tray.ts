import { app, Menu, nativeImage, Tray } from 'electron'
import { dictationMuted, setDictationMuted } from './dictation'

/**
 * whisp lives in the tray: there is no main window to close, only a settings
 * window that opens on demand, so the tray is the app's permanent handle —
 * and, with the red badge, the minimum honest UI: the one place "you are
 * being recorded" always lives.
 *
 * The icons are derived from the wisp mark (resources/logo.png) by
 * scripts/gen-icons.cjs: idle is the mark, recording adds the red badge,
 * muted is the mark at 35% — present, deliberately not listening.
 *
 * The menu is rebuilt rather than mutated: its items change with state (the
 * mute checkbox, the update entry that appears when a new version has been
 * downloaded), and rebuilding from one template keeps every state visible in
 * one place.
 */

import trayIdle from '../../resources/tray-idle.png?asset'
import trayRecording from '../../resources/tray-recording.png?asset'
import trayMuted from '../../resources/tray-muted.png?asset'

let tray: Tray | null = null
let recording = false
let openSettingsAction: (() => void) | null = null
/** Set when the updater has an installable version downloaded and waiting. */
let updateVersion: string | null = null
let updateAction: (() => void) | null = null

const icon = (path: string): Electron.NativeImage => nativeImage.createFromPath(path)

/** Icon and tooltip from the two facts: recording beats muted beats idle. */
function updateTray(): void {
  if (!tray) return
  const muted = dictationMuted()
  tray.setImage(icon(recording ? trayRecording : muted ? trayMuted : trayIdle))
  tray.setToolTip(recording ? 'whisp · dictating' : muted ? 'whisp · muted' : 'whisp')
}

function rebuildMenu(): void {
  if (!tray) return
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Open whisp', click: () => openSettingsAction?.() },
    {
      // The escape hatch for a second hotkey owner (e.g. SPCE's stable
      // build still hosting Whisper): the poll isn't an exclusive
      // registration, so two hosts BOTH fire on the same press. Muting one
      // is how they coexist. Session-only on purpose: a restart unmutes,
      // so a muted whisp can't silently stay deaf for a week.
      label: 'Mute dictation',
      type: 'checkbox',
      checked: dictationMuted(),
      click: (item) => {
        setDictationMuted(item.checked)
        updateTray()
      }
    },
    { type: 'separator' }
  ]
  if (updateVersion) {
    template.push({
      label: `Restart to update (${updateVersion})`,
      click: () => updateAction?.()
    })
  }
  template.push({ label: 'Quit', click: () => app.quit() })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

/** Flips the tray between resting and recording. Safe before initTray. */
export function setTrayRecording(next: boolean): void {
  recording = next
  updateTray()
}

/** The updater's one surface: a menu entry that installs on the human's schedule. */
export function setTrayUpdateReady(version: string, install: () => void): void {
  updateVersion = version
  updateAction = install
  rebuildMenu()
}

export function initTray(openSettings: () => void): void {
  if (tray) return
  openSettingsAction = openSettings
  tray = new Tray(icon(trayIdle))
  tray.setToolTip('whisp')
  rebuildMenu()
  tray.on('click', () => openSettingsAction?.())
}
