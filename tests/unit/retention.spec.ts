import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories, newId, nowIso } from '@main/store/repositories'
import { runRetention } from '@main/store/retention'

function makeDb() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  return { db, repos }
}

function insertSession(
  repos: ReturnType<typeof createRepositories>,
  projectId: string,
  startedAt: string,
  live = false,
) {
  const id = newId()
  repos.sessions.insert({
    id,
    projectId,
    engine: 'claude',
    sdkSessionId: null,
    status: live ? 'working' : 'done',
    statusDetail: null,
    branch: null,
    diffAdds: null,
    diffDels: null,
    usageUtilization: null,
    usageResetsAt: null,
    usageLimitType: null,
    startedAt,
    endedAt: live ? null : startedAt,
    endReason: live ? null : 'completed',
  })
  return id
}

function insertEvent(repos: ReturnType<typeof createRepositories>, sessionId: string, seq: number) {
  repos.events.insert({
    id: newId(),
    sessionId,
    seq,
    kind: 'raw_output',
    payload: { text: `line ${seq}` },
    noiseKind: null,
    createdAt: nowIso(),
  })
}

describe('runRetention', () => {
  it('keeps events for the recent sessions per project and prunes the rest', () => {
    const { db, repos } = makeDb()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const oldSession = insertSession(repos, project.id, '2026-07-01T10:00:00.000Z')
    // A flow run alone puts a dozen sessions on one project, so the kept window has to
    // be filled before anything is pruned.
    for (let n = 0; n < 12; n += 1) {
      insertSession(repos, project.id, `2026-07-${String(5 + n).padStart(2, '0')}T10:00:00.000Z`)
    }
    const previous = insertSession(repos, project.id, '2026-07-20T10:00:00.000Z')
    const current = insertSession(repos, project.id, '2026-07-21T10:00:00.000Z')
    insertEvent(repos, oldSession, 1)
    insertEvent(repos, oldSession, 2)
    insertEvent(repos, previous, 1)
    insertEvent(repos, current, 1)

    repos.events.flush()
    const dry = runRetention(db, { dryRun: true })
    expect(dry.eventsDeleted).toBe(2)
    expect(repos.events.page(oldSession)).toHaveLength(2)

    const result = runRetention(db)
    expect(result.eventsDeleted).toBe(2)
    expect(repos.events.page(oldSession)).toHaveLength(0)
    expect(repos.events.page(previous)).toHaveLength(1)
    expect(repos.events.page(current)).toHaveLength(1)
    expect(repos.sessions.byId(oldSession)).toBeDefined()
  })

  it('never prunes a session that is still running, however it ranks by start time', () => {
    const { db, repos } = makeDb()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\live', source: 'manual' })
    const live = insertSession(repos, project.id, '2026-07-01T08:00:00.000Z', true)
    const newer = insertSession(repos, project.id, '2026-07-01T09:00:00.000Z')
    const newest = insertSession(repos, project.id, '2026-07-01T10:00:00.000Z')
    insertEvent(repos, live, 1)
    insertEvent(repos, live, 2)
    insertEvent(repos, newer, 1)
    insertEvent(repos, newest, 1)
    repos.events.flush() 

    const result = runRetention(db)
    expect(result.eventsDeleted).toBe(0)
    expect(repos.events.page(live)).toHaveLength(2)
    expect(repos.events.page(newer)).toHaveLength(1)
    expect(repos.events.page(newest)).toHaveLength(1)
  })

  it('prunes resolved decisions older than 30 days but keeps recent and pending ones', () => {
    const { db, repos } = makeDb()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const sessionId = insertSession(repos, project.id, nowIso())

    const base = {
      sessionId,
      projectId: project.id,
      type: 'tool_permission' as const,
      toolName: 'Bash',
      title: 't',
      explanation: 'e',
      detail: 'd',
      risk: 'low' as const,
      createdAt: nowIso(),
      deliveryFailed: false,
    }
    const oldDecision = newId()
    repos.requests.insert({ ...base, id: oldDecision, status: 'approved', resolvedAt: nowIso() })
    db.prepare('UPDATE permission_requests SET resolvedAt = ? WHERE id = ?').run(
      '2026-05-01T00:00:00.000Z',
      oldDecision,
    )
    const recentDecision = newId()
    repos.requests.insert({ ...base, id: recentDecision, status: 'denied', resolvedAt: nowIso() })
    const pending = newId()
    repos.requests.insert({ ...base, id: pending, status: 'pending', resolvedAt: null })

    const result = runRetention(db, { now: new Date('2026-07-19T00:00:00.000Z') })
    expect(result.decisionsDeleted).toBe(1)
    expect(repos.requests.byId(oldDecision)).toBeUndefined()
    expect(repos.requests.byId(recentDecision)).toBeDefined()
    expect(repos.requests.byId(pending)).toBeDefined()
  })
})
