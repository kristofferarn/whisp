import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import type { DictationAudioBehavior } from '../shared/ipc'

/**
 * Windows playback suppression lives in a small, persistent PowerShell
 * helper. Windows exposes endpoint volume through COM and media playback
 * through WinRT; neither surface is available directly from Electron.
 * Keeping one hidden helper warm avoids paying PowerShell startup and C#
 * compilation latency when the hotkey lands.
 */

let helper: ChildProcessWithoutNullStreams | null = null
let activeBehavior: Exclude<DictationAudioBehavior, 'none'> | null = null
let stdoutBuffer = ''

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'audio-control.ps1')
    : join(__dirname, '../../resources/audio-control.ps1')
}

function logOutput(chunk: Buffer | string): void {
  stdoutBuffer += chunk.toString()
  const lines = stdoutBuffer.split(/\r?\n/)
  stdoutBuffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const result = JSON.parse(line) as { ok?: boolean; error?: unknown }
      if (result.ok === false) console.error('whisp: audio control failed:', result.error)
    } catch {
      console.error('whisp: unexpected audio control response:', line)
    }
  }
}

function ensureHelper(): ChildProcessWithoutNullStreams | null {
  if (process.platform !== 'win32') return null
  if (helper && !helper.killed) return helper

  stdoutBuffer = ''
  const child = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helperPath()
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  helper = child
  child.stdout.on('data', logOutput)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (message: string) => {
    if (message.trim()) console.error('whisp: audio control:', message.trim())
  })
  child.stdin.on('error', (error) => {
    console.error('whisp: audio control input failed:', error)
  })
  child.on('error', (error) => {
    console.error('whisp: audio control unavailable:', error)
  })
  child.on('exit', (code) => {
    if (helper === child) helper = null
    activeBehavior = null
    if (code && code !== 0) console.error(`whisp: audio control exited with code ${code}`)
  })
  return child
}

function command(action: 'lower' | 'pause' | 'restore' | 'quit'): void {
  const child = ensureHelper()
  if (!child?.stdin.writable) return
  child.stdin.write(`${JSON.stringify({ action })}\n`)
}

/** Warm the helper before the first hotkey needs it, unless playback stays alone. */
export function initAudioControl(behavior: DictationAudioBehavior): void {
  if (behavior !== 'none') ensureHelper()
}

/** Apply the selected policy once for the lifetime of one open microphone. */
export function beginAudioControl(behavior: DictationAudioBehavior): void {
  if (behavior === 'none' || activeBehavior !== null) return
  activeBehavior = behavior
  command(behavior)
}

/** Restore exactly what beginAudioControl changed, if anything. */
export function endAudioControl(): void {
  if (activeBehavior === null) return
  activeBehavior = null
  command('restore')
}

/** The helper also restores in its finally block if whisp disappears. */
export function stopAudioControl(): void {
  activeBehavior = null
  if (!helper) return
  command('quit')
  helper = null
}
