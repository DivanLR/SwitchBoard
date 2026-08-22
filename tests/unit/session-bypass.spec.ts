// Bypass sessions run inside the WSL container sandbox and keep their SDK transcript in
// a per-project container volume rather than the host's ~/.claude. Resume has to
// send the next session to the same place, so the flag has to survive the app
// process — these cover the 0/1 <-> boolean round trip and the pre-migration rows
// that predate the column.
import { describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '@main/store/db'
import { createRepositories, newId, nowIso, type Repositories } from '@main/store/repositories'
import type { Session } from '@shared/domain'

function setup(): { repos: Repositories; projectId: string; db: AppDatabase } {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  return { repos, projectId: project.id, db }
}

function sessionRow(projectId: string, bypassPermissions: boolean): Session {
  return {
    id: newId(),
    projectId,
    sdkSessionId: 'sdk-1',
    status: 'working',
    statusDetail: null,
    branch: null,
    diffAdds: null,
    diffDels: null,
    usageUtilization: null,
    usageResetsAt: null,
    usageLimitType: null,
    startedAt: nowIso(),
    endedAt: null,
    endReason: null,
    bypassPermissions,
  }
}

describe('session bypassPermissions persistence', () => {
  it('round-trips a bypass session as a real boolean', () => {
    const { repos, projectId } = setup()
    const row = sessionRow(projectId, true)
    repos.sessions.insert(row)
    expect(repos.sessions.byId(row.id)?.bypassPermissions).toBe(true)
    expect(repos.sessions.activeForProject(projectId)?.bypassPermissions).toBe(true)
  })

  it('round-trips a normal session as false, not undefined', () => {
    const { repos, projectId } = setup()
    const row = sessionRow(projectId, false)
    repos.sessions.insert(row)
    expect(repos.sessions.byId(row.id)?.bypassPermissions).toBe(false)
  })

  it('survives the end of the session, so resume can match it', () => {
    const { repos, projectId } = setup()
    const row = sessionRow(projectId, true)
    repos.sessions.insert(row)
    repos.sessions.update(row.id, { endedAt: nowIso(), endReason: 'completed' })
    expect(repos.sessions.latestEndedForProject(projectId)?.bypassPermissions).toBe(true)
  })

  it('reads rows written before the column existed as non-bypass', () => {
    const { repos, projectId, db } = setup()
    const row = sessionRow(projectId, true)
    repos.sessions.insert(row)
    // What an upgraded database looks like: the migration adds the column, and
    // every session that predates it carries NULL rather than 0.
    db.prepare('UPDATE sessions SET bypassPermissions = NULL WHERE id = ?').run(row.id)
    expect(repos.sessions.byId(row.id)?.bypassPermissions).toBe(false)
  })
})
