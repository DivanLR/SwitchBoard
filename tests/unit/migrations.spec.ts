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
    db.exec(`DELETE FROM migrations WHERE name = '037-claude-only'`)
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
      .prepare(`SELECT name FROM migrations WHERE name = '037-claude-only'`)
      .all()
    after.close()
    expect(applied).toEqual([])
  })
})

describe('037-claude-only', () => {
  it('forgets the Codex thread id a Codex session stored, so nothing resumes it as a Claude conversation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-037-'))
    dirs.push(dir)
    const path = join(dir, 'switchboard.db')
    const before = openDatabase(path)
    before.exec(`
      DELETE FROM migrations WHERE name = '037-claude-only';
      ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude';
      INSERT INTO projects (id, name, path, source, createdAt, position)
        VALUES ('p', 'p', 'C:/p', 'manual', '2026-09-01T00:00:00.000Z', 0);
      INSERT INTO sessions (id, projectId, sdkSessionId, status, startedAt, engine)
        VALUES ('codex', 'p', 'codex-thread', 'done', '2026-09-01T00:00:00.000Z', 'codex'),
               ('claude', 'p', 'claude-conversation', 'done', '2026-09-01T00:00:00.000Z', 'claude');
    `)
    before.close()

    const after = openDatabase(path)
    const ids = after.prepare('SELECT id, sdkSessionId FROM sessions ORDER BY id').all()
    after.close()

    expect(ids).toEqual([
      { id: 'claude', sdkSessionId: 'claude-conversation' },
      { id: 'codex', sdkSessionId: null },
    ])
  })

  it('keeps a bypass project, its container flag and a bypass session, which are still a feature', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-037-bypass-'))
    dirs.push(dir)
    const path = join(dir, 'switchboard.db')
    const before = openDatabase(path)
    before.exec(`
      DELETE FROM migrations WHERE name = '037-claude-only';
      ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude';
      INSERT INTO projects (id, name, path, source, createdAt, position, defaultSessionMode, useContainers)
        VALUES ('p', 'p', 'C:/p', 'manual', '2026-09-01T00:00:00.000Z', 0, 'bypass', 1);
      INSERT INTO sessions (id, projectId, sdkSessionId, status, startedAt, bypassPermissions)
        VALUES ('s', 'p', 'claude-conversation', 'done', '2026-09-01T00:00:00.000Z', 1);
    `)
    before.close()

    const after = openDatabase(path)
    const project = after.prepare('SELECT defaultSessionMode, useContainers FROM projects').get()
    const session = after.prepare('SELECT bypassPermissions FROM sessions').get()
    after.close()

    expect(project).toEqual({ defaultSessionMode: 'bypass', useContainers: 1 })
    expect(session).toEqual({ bypassPermissions: 1 })
  })
})
