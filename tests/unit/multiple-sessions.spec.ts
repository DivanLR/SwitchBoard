// A project may run several sessions at once. This was forbidden until 2026-08-05,
// when the owner reversed it, so these tests exist to hold the new rule in place: the
// old one was enforced by an explicit refusal that is easy to reintroduce by reflex.
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

function sessionRow(projectId: string, startedAt: string): Session {
  return {
    id: newId(),
    projectId,
    sdkSessionId: null,
    status: 'working',
    statusDetail: null,
    branch: null,
    diffAdds: null,
    diffDels: null,
    usageUtilization: null,
    usageResetsAt: null,
    usageLimitType: null,
    startedAt,
    endedAt: null,
    endReason: null,
  }
}

describe('a project can hold several live sessions', () => {
  it('stores them all, rather than the schema refusing the second', () => {
    const { repos, projectId } = setup()
    const first = sessionRow(projectId, '2026-08-05T10:00:00.000Z')
    const second = sessionRow(projectId, '2026-08-05T10:05:00.000Z')
    repos.sessions.insert(first)
    repos.sessions.insert(second)

    const live = repos.sessions.listUnended().filter((s) => s.projectId === projectId)
    expect(live).toHaveLength(2)
    expect(live.map((s) => s.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('resolves "the project\'s session" to the newest live one, which is what the feature flows want', () => {
    const { repos, projectId } = setup()
    const older = sessionRow(projectId, '2026-08-05T10:00:00.000Z')
    const newer = sessionRow(projectId, '2026-08-05T10:05:00.000Z')
    repos.sessions.insert(older)
    repos.sessions.insert(newer)
    // activeForProject already ordered by startedAt DESC LIMIT 1 before the limit was
    // lifted, so every caller that means "a live session here" keeps working.
    expect(repos.sessions.activeForProject(projectId)?.id).toBe(newer.id)
  })

  it('keeps counting each live session separately, so the board reads two running', () => {
    const { repos, projectId } = setup()
    repos.sessions.insert(sessionRow(projectId, '2026-08-05T10:00:00.000Z'))
    repos.sessions.insert(sessionRow(projectId, '2026-08-05T10:05:00.000Z'))
    const running = repos.sessions.listUnended().filter((s) => s.status === 'working')
    expect(running).toHaveLength(2)
  })

  it('ending one leaves the other running', () => {
    const { repos, projectId } = setup()
    const first = sessionRow(projectId, '2026-08-05T10:00:00.000Z')
    const second = sessionRow(projectId, '2026-08-05T10:05:00.000Z')
    repos.sessions.insert(first)
    repos.sessions.insert(second)

    repos.sessions.update(second.id, { endedAt: nowIso(), endReason: 'stopped', status: 'done' })

    const live = repos.sessions.listUnended().filter((s) => s.projectId === projectId)
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe(first.id)
    // And the project's "a live session" answer falls back to the one still running,
    // rather than to the newest row overall.
    expect(repos.sessions.activeForProject(projectId)?.id).toBe(first.id)
  })

  it('keeps each project\'s sessions to itself', () => {
    const { repos, projectId } = setup()
    const other = repos.projects.insert({ name: 'b', path: 'C:\\b', source: 'manual' })
    repos.sessions.insert(sessionRow(projectId, '2026-08-05T10:00:00.000Z'))
    repos.sessions.insert(sessionRow(projectId, '2026-08-05T10:01:00.000Z'))
    repos.sessions.insert(sessionRow(other.id, '2026-08-05T10:02:00.000Z'))

    expect(repos.sessions.listUnended().filter((s) => s.projectId === projectId)).toHaveLength(2)
    expect(repos.sessions.listUnended().filter((s) => s.projectId === other.id)).toHaveLength(1)
  })
})
