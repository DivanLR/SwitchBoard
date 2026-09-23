import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@main/store/db'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('npm run prune -- --dry-run', () => {
  it('runs on plain Node and reads the database without migrating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prune-cli-'))
    dirs.push(dir)
    const path = join(dir, 'switchboard.db')
    const db = openDatabase(path)
    db.exec(`DELETE FROM migrations WHERE name = '042-session-container-home'`)
    db.close()

    const out = execFileSync(
      process.execPath,
      ['src/main/store/prune-cli.ts', '--dry-run', '--db', path],
      {
        encoding: 'utf8',
      },
    )

    expect(out).toContain('[dry run] Would delete 0 event rows')
    const after = new DatabaseSync(path, { readOnly: true })
    const applied = after
      .prepare(`SELECT name FROM migrations WHERE name = '042-session-container-home'`)
      .all()
    after.close()
    expect(applied).toEqual([])
  })
})

describe('reopening a database', () => {
  it('keeps a Codex session on Codex with its thread id, and a bypass project and session as they were', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-reopen-'))
    dirs.push(dir)
    const path = join(dir, 'switchboard.db')
    const before = openDatabase(path)
    before.exec(`
      INSERT INTO projects (id, name, path, source, createdAt, position, defaultSessionMode, useContainers)
        VALUES ('p', 'p', 'C:/p', 'manual', '2026-09-01T00:00:00.000Z', 0, 'bypass', 1);
      INSERT INTO sessions (id, projectId, sdkSessionId, status, startedAt, engine, bypassPermissions)
        VALUES ('codex', 'p', 'codex-thread', 'done', '2026-09-01T00:00:00.000Z', 'codex', 0),
               ('claude', 'p', 'claude-conversation', 'done', '2026-09-01T00:00:00.000Z', 'claude', 1);
    `)
    before.close()

    const after = openDatabase(path)
    const sessions = after
      .prepare('SELECT id, engine, sdkSessionId, bypassPermissions FROM sessions ORDER BY id')
      .all()
    const project = after.prepare('SELECT defaultSessionMode, useContainers FROM projects').get()
    const applied = after.prepare(`SELECT name FROM migrations WHERE name = '037-claude-only'`).all()
    after.close()

    expect(sessions).toEqual([
      { id: 'claude', engine: 'claude', sdkSessionId: 'claude-conversation', bypassPermissions: 1 },
      { id: 'codex', engine: 'codex', sdkSessionId: 'codex-thread', bypassPermissions: 0 },
    ])
    expect(project).toEqual({ defaultSessionMode: 'bypass', useContainers: 1 })
    expect(applied).toEqual([])
  })
})
