// T047: retention — events survive for the current and previous session per
// project only; resolved decisions older than 30 days are pruned; sessions
// rows and pending items are kept (FR-021a).
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories, newId, nowIso } from '@main/store/repositories'
import { runRetention } from '@main/store/retention'

function makeDb() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  return { db, repos }
}

function insertSession(repos: ReturnType<typeof createRepositories>, projectId: string, startedAt: string) {
  const id = newId()
  repos.sessions.insert({
    id,
    projectId,
    sdkSessionId: null,
    status: 'done',
    statusDetail: null,
    branch: null,
    diffAdds: null,
    diffDels: null,
    usageUtilization: null,
    usageResetsAt: null,
    usageLimitType: null,
    startedAt,
    endedAt: startedAt,
    endReason: 'completed',
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
  it('keeps events for the two most recent sessions per project and prunes the rest', () => {
    const { db, repos } = makeDb()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const oldSession = insertSession(repos, project.id, '2026-07-01T10:00:00.000Z')
    const previous = insertSession(repos, project.id, '2026-07-10T10:00:00.000Z')
    const current = insertSession(repos, project.id, '2026-07-18T10:00:00.000Z')
    insertEvent(repos, oldSession, 1)
    insertEvent(repos, oldSession, 2)
    insertEvent(repos, previous, 1)
    insertEvent(repos, current, 1)

    const dry = runRetention(db, repos, { dryRun: true })
    expect(dry.eventsDeleted).toBe(2)
    // Dry run deletes nothing.
    expect(repos.events.page(oldSession)).toHaveLength(2)

    const result = runRetention(db, repos)
    expect(result.eventsDeleted).toBe(2)
    expect(repos.events.page(oldSession)).toHaveLength(0)
    expect(repos.events.page(previous)).toHaveLength(1)
    expect(repos.events.page(current)).toHaveLength(1)
    // Session rows are kept so history references stay resolvable.
    expect(repos.sessions.byId(oldSession)).toBeDefined()
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

    const result = runRetention(db, repos, { now: new Date('2026-07-19T00:00:00.000Z') })
    expect(result.decisionsDeleted).toBe(1)
    expect(repos.requests.byId(oldDecision)).toBeUndefined()
    expect(repos.requests.byId(recentDecision)).toBeDefined()
    expect(repos.requests.byId(pending)).toBeDefined()
  })
})
