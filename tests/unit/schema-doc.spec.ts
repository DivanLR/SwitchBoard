import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  comboDocPath,
  readComboDoc,
  readSchemaDoc,
  schemaDocPath,
} from '@main/mcp/schema-doc'
import { comboDocRelPath } from '@shared/mcp-combo'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'schema-doc-'))
  dirs.push(dir)
  return dir
}

describe('schemaDocPath', () => {
  it('puts the doc under the project .switchboard folder', () => {
    expect(schemaDocPath('C:\\proj')).toBe(join('C:\\proj', '.switchboard', 'db-schema.md'))
  })
})

describe('readSchemaDoc', () => {
  it('returns null when the project has never been scanned', () => {
    expect(readSchemaDoc(project())).toBeNull()
  })

  it('reads the doc the scan wrote', () => {
    const dir = project()
    mkdirSync(join(dir, '.switchboard'), { recursive: true })
    writeFileSync(schemaDocPath(dir), '# tables\n', 'utf8')
    expect(readSchemaDoc(dir)).toBe('# tables\n')
  })
})

describe('comboDocPath', () => {
  it('resolves the shared relative path against the project', () => {
    const servers = ['postgres — production', 'github']
    expect(comboDocPath('C:\\proj', servers)).toBe(
      join('C:\\proj', ...comboDocRelPath(servers).split('/')),
    )
  })

  it('is order-independent, so the same set of servers reads one file', () => {
    expect(comboDocPath('C:\\p', ['a', 'b'])).toBe(comboDocPath('C:\\p', ['b', 'a']))
  })

  it('separates server sets whose names sanitise identically', () => {
    expect(comboDocPath('C:\\p', ['postgres — production'])).not.toBe(
      comboDocPath('C:\\p', ['postgres production']),
    )
  })
})

describe('readComboDoc', () => {
  it('returns null for a combination never scanned', () => {
    expect(readComboDoc(project(), ['github'])).toBeNull()
  })

  it('reads the doc written for that exact set of servers', () => {
    const dir = project()
    const servers = ['github', 'postgres']
    mkdirSync(join(dir, '.switchboard', 'scans'), { recursive: true })
    writeFileSync(comboDocPath(dir, servers), 'combo scan', 'utf8')

    expect(readComboDoc(dir, servers)).toBe('combo scan')
    expect(readComboDoc(dir, ['postgres', 'github'])).toBe('combo scan')
    expect(readComboDoc(dir, ['github'])).toBeNull()
  })
})
