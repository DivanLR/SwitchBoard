// The per-project session mode: how a project's sessions decide what they may do.
// Two facts matter and are easy to get wrong. A project that predates the setting
// must keep behaving exactly as it did (migration 022 backfills 'auto', which is
// what every session already spawned as), and the mode must survive the round trip
// through SQLite rather than living only in the object the insert returned.
import { describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '@main/store/db'
import { createRepositories, type Repositories } from '@main/store/repositories'
import { registerProject } from '@main/projects/discovery'
import { resolvePermissionMode } from '@main/sessions/session'
import { DEFAULT_SESSION_MODE, SESSION_MODES } from '@shared/domain'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function setup(): { repos: Repositories; db: AppDatabase } {
  const db = openDatabase(':memory:')
  return { repos: createRepositories(db), db }
}

describe('a project carries its own session mode', () => {
  it('defaults to auto, so a project added without choosing behaves as every project used to', () => {
    const { repos } = setup()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    expect(project.defaultSessionMode).toBe('auto')
    expect(repos.projects.byId(project.id)?.defaultSessionMode).toBe('auto')
    expect(DEFAULT_SESSION_MODE).toBe('auto')
  })

  it('stores every mode the app offers and reads it back from the row, not the return value', () => {
    const { repos } = setup()
    for (const { value } of SESSION_MODES) {
      const project = repos.projects.insert({
        name: value,
        path: `C:\\p-${value}`,
        source: 'manual',
        defaultSessionMode: value,
      })
      // byId re-reads the column: an insert that forgot to write it would still
      // return the right object here and fail on the next launch instead.
      expect(repos.projects.byId(project.id)?.defaultSessionMode).toBe(value)
    }
  })

  it('changes on request and applies to the project from then on', () => {
    const { repos } = setup()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    repos.projects.setSessionMode(project.id, 'bypass')
    expect(repos.projects.byId(project.id)?.defaultSessionMode).toBe('bypass')
    repos.projects.setSessionMode(project.id, 'plan')
    expect(repos.projects.byId(project.id)?.defaultSessionMode).toBe('plan')
  })

  it('refuses a value outside the five, at the schema rather than only in TypeScript', () => {
    const { repos, db } = setup()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    expect(() =>
      db
        .prepare('UPDATE projects SET defaultSessionMode = ? WHERE id = ?')
        .run('whatever', project.id),
    ).toThrow()
    // The refusal left the old value in place rather than a null.
    expect(repos.projects.byId(project.id)?.defaultSessionMode).toBe('auto')
  })

  it('keeps the mode across archive and re-add, and lets a re-add choose a new one', () => {
    const { repos } = setup()
    // A real folder: registerProject stats the path before it will touch a row.
    const dir = mkdtempSync(join(tmpdir(), 'sb-mode-'))
    const first = registerProject(repos, { path: dir, defaultSessionMode: 'acceptEdits' })
    expect(first.defaultSessionMode).toBe('acceptEdits')

    repos.projects.archive(first.id)
    // Re-added without choosing: the archived row keeps what it had.
    const again = registerProject(repos, { path: dir })
    expect(again.id).toBe(first.id)
    expect(again.defaultSessionMode).toBe('acceptEdits')
    expect(repos.projects.byId(first.id)?.defaultSessionMode).toBe('acceptEdits')

    repos.projects.archive(first.id)
    // Re-added WITH a choice: the developer just picked, so the choice wins.
    const third = registerProject(repos, { path: dir, defaultSessionMode: 'plan' })
    expect(third.defaultSessionMode).toBe('plan')
    expect(repos.projects.byId(first.id)?.defaultSessionMode).toBe('plan')
  })
})

describe('the mode a project holds is the mode the SDK spawns in', () => {
  it('maps every stored value onto a real SDK permission mode', () => {
    const { repos } = setup()
    for (const { value } of SESSION_MODES) {
      const project = repos.projects.insert({
        name: value,
        path: `C:\\q-${value}`,
        source: 'manual',
        defaultSessionMode: value,
      })
      const stored = repos.projects.byId(project.id)!.defaultSessionMode
      expect(resolvePermissionMode(stored)).toBe(value === 'bypass' ? 'bypassPermissions' : value)
    }
  })
})
