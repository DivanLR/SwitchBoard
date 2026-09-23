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

describe('044-flow-kinds', () => {
  it('keeps every run and stage row, makes an old run a feature, and accepts the bug and idea stages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-044-'))
    dirs.push(dir)
    const path = join(dir, 'switchboard.db')
    const before = openDatabase(path)
    const stages = `'spec', 'plan', 'build', 'clean', 'test', 'review', 'ship'`
    before.exec(`
      DELETE FROM migrations WHERE name = '044-flow-kinds';
      DROP TABLE flow_stages;
      DROP TABLE flow_runs;
      CREATE TABLE flow_runs (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('ado', 'text', 'spec')), sourceRef TEXT, sourceUrl TEXT,
        description TEXT NOT NULL DEFAULT '', stacks TEXT NOT NULL DEFAULT '[]',
        stage TEXT NOT NULL CHECK (stage IN (${stages})),
        status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'done', 'failed', 'cancelled')),
        autopilot INTEGER NOT NULL DEFAULT 0, autoShip INTEGER NOT NULL DEFAULT 0, baseBranch TEXT, branch TEXT,
        worktreePath TEXT, specDir TEXT, prUrl TEXT, prId TEXT, note TEXT, createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL, finishedAt TEXT, repos TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE flow_stages (
        runId TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN (${stages})),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'review', 'approved', 'skipped', 'failed')),
        sessionId TEXT, attempts INTEGER NOT NULL DEFAULT 0, summary TEXT, report TEXT, feedback TEXT,
        startedAt TEXT, finishedAt TEXT, PRIMARY KEY (runId, stage)
      );
      INSERT INTO projects (id, name, path, source, createdAt, position)
        VALUES ('p', 'p', 'C:/p', 'manual', '2026-09-01T00:00:00.000Z', 0);
      INSERT INTO flow_runs (id, projectId, title, source, stage, status, specDir, createdAt, updatedAt, repos)
        VALUES ('r', 'p', 'Cart', 'text', 'build', 'waiting', 'specs/001-cart', '2026-09-01', '2026-09-01', '[]');
      INSERT INTO flow_stages (runId, stage, status, attempts, summary)
        VALUES ('r', 'spec', 'approved', 1, 'Wrote it.'), ('r', 'build', 'review', 2, 'Built it.');
    `)
    before.close()

    const after = openDatabase(path)
    const run = after.prepare('SELECT kind, slug, checklist, title, stage, specDir FROM flow_runs').get()
    const rows = after.prepare('SELECT stage, status, attempts, summary FROM flow_stages ORDER BY stage').all()
    after.exec(`
      INSERT INTO flow_runs (id, projectId, kind, slug, title, source, stage, status, createdAt, updatedAt)
        VALUES ('i', 'p', 'idea', 'offline', 'Offline', 'text', 'decide', 'waiting', '2026-09-02', '2026-09-02');
      INSERT INTO flow_stages (runId, stage, status) VALUES ('i', 'decide', 'review');
      DELETE FROM flow_runs WHERE id = 'r';
    `)
    const left = after.prepare('SELECT runId, stage FROM flow_stages').all()
    after.close()

    expect(run).toEqual({ kind: 'feature', slug: null, checklist: 0, title: 'Cart', stage: 'build', specDir: 'specs/001-cart' })
    expect(rows).toEqual([
      { stage: 'build', status: 'review', attempts: 2, summary: 'Built it.' },
      { stage: 'spec', status: 'approved', attempts: 1, summary: 'Wrote it.' },
    ])
    expect(left).toEqual([{ runId: 'i', stage: 'decide' }])
  })
})
