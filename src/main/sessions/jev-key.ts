import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcError, JevKeyStatus } from '@shared/ipc-types'

let cached: string | null | undefined

function keyFile(): string {
  return join(app.getPath('userData'), 'jev-key.bin')
}

export function jevKeyStatus(): JevKeyStatus {
  return { configured: readJevKey() !== null, encryption: safeStorage.isEncryptionAvailable() }
}

export function saveJevKey(raw: string): JevKeyStatus {
  const key = raw.trim()
  if (key.length < 8 || key.length > 400 || /\s/.test(key)) {
    throw { code: 'INVALID_PATH', message: 'That does not look like an API key: paste the key alone, with no spaces.' } satisfies IpcError
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw {
      code: 'UNSUPPORTED',
      message: 'This machine cannot encrypt the key, so Switchboard will not store it.',
    } satisfies IpcError
  }
  writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 })
  cached = key
  return jevKeyStatus()
}

export function readJevKey(): string | null {
  if (cached !== undefined) return cached
  try {
    cached = existsSync(keyFile()) ? safeStorage.decryptString(readFileSync(keyFile())) : null
  } catch {
    cached = null
  }
  return cached
}

export function clearJevKey(): JevKeyStatus {
  rmSync(keyFile(), { force: true })
  cached = null
  return jevKeyStatus()
}
