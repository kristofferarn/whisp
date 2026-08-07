import { app, Menu, nativeImage, Tray } from 'electron'
import { dictationMuted, setDictationMuted } from './dictation'

/**
 * whisp lives in the tray: there is no main window to close, only a settings
 * window that opens on demand, so the tray is the app's permanent handle —
 * and, with the red dot, the minimum honest UI: the one place "you are being
 * recorded" always lives.
 *
 * The icons are derived from the wisp mark (resources/logo.png) by
 * scripts/gen-icons.cjs: idle is the mark, recording adds the red badge —
 * with the window hidden, the tray is the only place "you are being
 * recorded" always lives — and muted is the mark at 35%: present,
 * deliberately not listening.
 */

import trayIdle from '../../resources/tray-idle.png?asset'
import trayRecording from '../../resources/tray-recording.png?asset'
import trayMuted from '../../resources/tray-muted.png?asset'

let tray: Tray | null = null
let recording = false

const icon = (path: string): Electron.NativeImage => nativeImage.createFromPath(path)

/** Icon and tooltip from the two facts: recording beats muted beats idle. */
function updateTray(): void {
  if (!tray) return
  const muted = dictationMuted()
  tray.setImage(icon(recording ? trayRecording : muted ? trayMuted : trayIdle))
  tray.setToolTip(recording ? 'whisp · dictating' : muted ? 'whisp · muted' : 'whisp')
}

/** Flips the tray between resting and recording. Safe before initTray. */
export function setTrayRecording(next: boolean): void {
  recording = next
  updateTray()
}

export function initTray(openSettings: () => void): void {
  if (tray) return

  tray = new Tray(icon(trayIdle))
  tray.setToolTip('whisp')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open whisp', click: openSettings },
      {
        // The escape hatch for a second hotkey owner (e.g. SPCE's stable
        // build still hosting Whisper): the poll isn't an exclusive
        // registration, so two hosts BOTH fire on the same press. Muting one
        // is how they coexist. Session-only on purpose: a restart unmutes,
        // so a muted whisp can't silently stay deaf for a week.
        label: 'Mute dictation',
        type: 'checkbox',
        checked: false,
        click: (item) => {
          setDictationMuted(item.checked)
          updateTray()
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('click', openSettings)
}
