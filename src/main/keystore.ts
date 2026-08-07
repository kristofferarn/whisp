import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage, type IpcMain } from 'electron'
import { IPC, type KeyStatus } from '../shared/ipc'

/**
 * The OpenAI API key, main-process side. It never crosses to a renderer —
 * the settings window sees only "configured, ends in ...abcd" — and is spent
 * on exactly one thing: dictation's transcription requests, which also run
 * in main. Stored encrypted with safeStorage (DPAPI on Windows) when the OS
 * offers it, base64 of the raw key when it doesn't.
 */

interface StoredKey {
  /** Base64 — of the DPAPI ciphertext when `encrypted`, of the raw key when not. */
  value: string
  encrypted: boolean
}

function keyPath(): string {
  return join(app.getPath('userData'), 'openai-key.json')
}

async function loadKey(): Promise<string | null> {
  try {
    const stored = JSON.parse(await readFile(keyPath(), 'utf8')) as StoredKey
    const buf = Buffer.from(stored.value, 'base64')
    return stored.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch {
    // No file, or a key written on another machine that DPAPI can't open —
    // either way there is no usable key, which status() reports as unset.
    return null
  }
}

async function saveKey(key: string): Promise<void> {
  const encrypted = safeStorage.isEncryptionAvailable()
  const value = encrypted
    ? safeStorage.encryptString(key).toString('base64')
    : Buffer.from(key, 'utf8').toString('base64')
  await writeFile(keyPath(), JSON.stringify({ value, encrypted } satisfies StoredKey), 'utf8')
}

/** The key dictation should spend. Null means: tell the human via the pill. */
export function resolveKey(): Promise<string | null> {
  return loadKey()
}

export async function keyStatus(): Promise<KeyStatus> {
  const key = await loadKey()
  return { configured: !!key, last4: key ? key.slice(-4) : null }
}

async function setKey(key: string | null): Promise<KeyStatus> {
  const trimmed = key?.trim()
  if (trimmed) {
    await saveKey(trimmed)
  } else {
    await unlink(keyPath()).catch(() => undefined)
  }
  return keyStatus()
}

export function registerKeyHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.keyStatus, () => keyStatus())
  ipcMain.handle(IPC.keySet, (_e, key: string | null) => setKey(key))
}
