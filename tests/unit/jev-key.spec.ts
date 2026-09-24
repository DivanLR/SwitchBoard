import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = { dir: '', encryption: true }

vi.mock('electron', () => ({
  app: { getPath: () => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => state.encryption,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (data: Buffer) => {
      const text = data.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return text.slice(4)
    },
  },
}))

async function load(): Promise<typeof import('@main/sessions/jev-key')> {
  vi.resetModules()
  return import('@main/sessions/jev-key')
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'jev-key-'))
  state.encryption = true
})

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true })
})

describe('the Jev key store', () => {
  it('saves the key encrypted and reports it as configured', async () => {
    const jev = await load()
    expect(jev.saveJevKey('  ts_live_abcdef123  ')).toEqual({ configured: true, encryption: true })
    const reread = await load()
    expect(reread.readJevKey()).toBe('ts_live_abcdef123')
  })

  it('reports no key when the saved file cannot be decrypted', async () => {
    writeFileSync(join(state.dir, 'jev-key.bin'), 'not ciphertext')
    const jev = await load()
    expect(jev.jevKeyStatus()).toEqual({ configured: false, encryption: true })
    expect(jev.readJevKey()).toBeNull()
  })

  it('refuses to store a key when encryption is unavailable', async () => {
    state.encryption = false
    const jev = await load()
    expect(() => jev.saveJevKey('ts_live_abcdef123')).toThrow()
    expect(jev.jevKeyStatus().configured).toBe(false)
  })

  it('refuses a value that is not a key alone', async () => {
    const jev = await load()
    expect(() => jev.saveJevKey('two words')).toThrow()
    expect(() => jev.saveJevKey('short')).toThrow()
  })

  it('forgets the key when it is removed', async () => {
    const jev = await load()
    jev.saveJevKey('ts_live_abcdef123')
    expect(jev.clearJevKey()).toEqual({ configured: false, encryption: true })
    expect(jev.readJevKey()).toBeNull()
  })
})
