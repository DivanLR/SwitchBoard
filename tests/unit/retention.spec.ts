import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories, newId, nowIso } from '@main/store/repositories'
import { runRetention } from '@main/store/retention'
import { archiveDaysLeft } from '@shared/domain'

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

  it('keeps the events of a session a stage of an existing Flow run points at', () => {
    const { db, repos } = makeDb()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\flow', source: 'manual' })
    const stageSession = insertSession(repos, project.id, '2026-07-01T08:00:00.000Z')
    for (let n = 0; n < 12; n += 1) {
      insertSession(repos, project.id, `2026-07-${String(5 + n).padStart(2, '0')}T10:00:00.000Z`)
    }
    insertEvent(repos, stageSession, 1)
    const run = repos.flowRuns.start({
      projectId: project.id,
      title: 'Checkout',
      source: 'text',
      sourceRef: null,
      sourceUrl: null,
      description: '',
      stacks: ['dotnet'],
      stage: 'spec',
      autopilot: false,
      autoShip: false,
      baseBranch: 'main',
    })
    repos.flowStages.ensureAll(run.id)
    repos.flowStages.update(run.id, 'spec', { sessionId: stageSession })
    repos.events.flush()

    expect(runRetention(db).eventsDeleted).toBe(0)
    expect(repos.events.page(stageSession)).toHaveLength(1)
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

type Repos = ReturnType<typeof createRepositories>

function startRun(repos: Repos, projectId: string) {
  return repos.flowRuns.start({
    projectId,
    title: 'Checkout',
    source: 'text',
    sourceRef: null,
    sourceUrl: null,
    description: '',
    stacks: ['dotnet'],
    stage: 'spec',
    autopilot: false,
    autoShip: false,
    baseBranch: 'main',
  })
}

function fillProject(repos: Repos, projectId: string): string {
  const sessionId = insertSession(repos, projectId, '2026-08-01T10:00:00.000Z')
  insertEvent(repos, sessionId, 1)
  repos.events.flush()
  repos.requests.insert({
    id: newId(),
    sessionId,
    projectId,
    type: 'tool_permission',
    toolName: 'Bash',
    title: 't',
    explanation: 'e',
    detail: 'd',
    risk: 'low',
    status: 'approved',
    createdAt: nowIso(),
    resolvedAt: nowIso(),
    deliveryFailed: false,
  })
  repos.standingRules.insert({
    projectId,
    toolName: 'Bash',
    matcher: { kind: 'command_prefix', value: 'npm test' },
    createdFromRequestId: 'manual',
  })
  repos.drafts.insert(projectId, 'half a thought')
  repos.commandHistory.add(projectId, '/speckit-plan')
  repos.projectCommands.set(projectId, [{ name: 'ponytail' }])
  repos.taskQueue.add(projectId, 'next task')
  repos.verifyRuns.start({ projectId, stackId: 'dotnet', sessionId, branch: 'main', requested: ['unit'] })
  repos.diagramRequests.record(projectId, 'flow.html', 'the flow', sessionId)
  const run = startRun(repos, projectId)
  repos.flowStages.ensureAll(run.id)
  repos.flowStages.update(run.id, 'spec', { sessionId })
  const settings = repos.settings.get()
  repos.settings.set({
    projectGroupOf: { ...settings.projectGroupOf, [projectId]: 'g1' },
    projectTestStacks: { ...settings.projectTestStacks, [projectId]: 'dotnet' },
    projectSuiteCommands: { ...settings.projectSuiteCommands, [projectId]: { unit: 'dotnet test' } },
    projectTestSelection: { ...settings.projectTestSelection, [projectId]: ['unit'] },
    projectIsolatedRuns: { ...settings.projectIsolatedRuns, [projectId]: true },
    projectAcceptedGates: { ...settings.projectAcceptedGates, [projectId]: ['build'] },
    disabledCommands: { ...settings.disabledCommands, [projectId]: ['ponytail'] },
  })
  return sessionId
}

function rowsFor(db: ReturnType<typeof openDatabase>, projectId: string, sessionId: string): Record<string, number> {
  const out: Record<string, number> = {}
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  for (const { name } of tables) {
    const columns = (db.prepare('SELECT name FROM pragma_table_info(?)').all(name) as { name: string }[]).map(
      (c) => c.name,
    )
    const where = [
      ...(columns.includes('projectId') ? [`projectId = '${projectId}'`] : []),
      ...(columns.includes('sessionId') ? [`sessionId = '${sessionId}'`] : []),
      ...(name === 'projects' ? [`id = '${projectId}'`] : []),
      ...(name === 'flow_stages' ? [`runId IN (SELECT id FROM flow_runs WHERE projectId = '${projectId}')`] : []),
    ]
    if (where.length === 0) continue
    out[name] = (
      db.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE ${where.join(' OR ')}`).get() as { n: number }
    ).n
  }
  return out
}

describe('deleting a project', () => {
  it('removes every row and settings entry that belongs to it, and nothing of another project', () => {
    const { db, repos } = makeDb()
    const gone = repos.projects.insert({ name: 'gone', path: 'C:\\gone', source: 'manual' })
    const kept = repos.projects.insert({ name: 'kept', path: 'C:\\kept', source: 'manual' })
    const goneSession = fillProject(repos, gone.id)
    const keptSession = fillProject(repos, kept.id)
    const before = rowsFor(db, gone.id, goneSession)
    expect(Object.values(before).every((n) => n > 0)).toBe(true)
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining([
        'projects',
        'sessions',
        'events',
        'permission_requests',
        'permission_rules',
        'drafts',
        'command_history',
        'project_commands',
        'task_queue',
        'verify_runs',
        'diagram_requests',
        'flow_runs',
        'flow_stages',
      ]),
    )

    const keptBefore = rowsFor(db, kept.id, keptSession)

    expect(repos.projects.deleteBlocker(gone.id)).toBeNull()
    repos.projects.delete(gone.id)

    expect(Object.values(rowsFor(db, gone.id, goneSession)).every((n) => n === 0)).toBe(true)
    expect(rowsFor(db, kept.id, keptSession)).toEqual(keptBefore)
    const settings = repos.settings.get()
    for (const map of [
      settings.projectGroupOf,
      settings.projectTestStacks,
      settings.projectSuiteCommands,
      settings.projectTestSelection,
      settings.projectIsolatedRuns,
      settings.projectAcceptedGates,
      settings.disabledCommands,
    ]) {
      expect(Object.keys(map)).toEqual([kept.id])
    }
  })

  it('also drops the entries of a per project settings map the defaults do not list', () => {
    const { db, repos } = makeDb()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?)").run(
      JSON.stringify({ projectModels: { [project.id]: 'claude-opus-5', other: 'x' }, effort: 'max' }),
    )
    repos.projects.delete(project.id)
    const stored = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string }).value,
    )
    expect(stored).toEqual({ projectModels: { other: 'x' }, effort: 'max' })
  })

  it('is refused while a session is live or a Flow run owns a worktree, its own or as a companion', () => {
    const { repos } = makeDb()
    const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
    const other = repos.projects.insert({ name: 'b', path: 'C:\\b', source: 'manual' })
    insertSession(repos, project.id, '2026-08-01T10:00:00.000Z', true)
    expect(repos.projects.deleteBlocker(project.id)).toBe('live_session')
    repos.sessions.reconcileAllEnded('stopped')
    expect(repos.projects.deleteBlocker(project.id)).toBeNull()

    const own = startRun(repos, project.id)
    repos.flowRuns.update(own.id, { worktreePath: 'C:\\a.worktrees\\checkout' })
    expect(repos.projects.deleteBlocker(project.id)).toBe('flow_worktree')
    repos.flowRuns.update(own.id, { worktreePath: null })
    expect(repos.projects.deleteBlocker(project.id)).toBeNull()

    const shared = startRun(repos, other.id)
    const repo = (projectId: string, worktreePath: string | null) => ({
      projectId,
      name: projectId,
      path: 'C:\\x',
      stacks: [],
      baseBranch: 'main',
      branch: 'feature/checkout',
      worktreePath,
      prUrl: null,
      prId: null,
    })
    repos.flowRuns.update(shared.id, {
      worktreePath: 'C:\\b.worktrees\\checkout',
      repos: [repo(other.id, 'C:\\b.worktrees\\checkout'), repo(project.id, 'C:\\a.worktrees\\checkout')],
    })
    expect(repos.projects.deleteBlocker(project.id)).toBe('flow_worktree')
    expect(repos.projects.deleteBlocker(other.id)).toBe('flow_worktree')
  })

  it('happens in the retention pass once a project has been archived for more than 30 days', () => {
    const { db, repos } = makeDb()
    const now = new Date('2026-09-23T03:00:00.000Z')
    const archive = (name: string, archivedAt: string) => {
      const project = repos.projects.insert({ name, path: `C:\\${name}`, source: 'manual' })
      db.prepare('UPDATE projects SET archivedAt = ? WHERE id = ?').run(archivedAt, project.id)
      return project.id
    }
    const expired = archive('expired', '2026-08-23T02:59:00.000Z')
    const recent = archive('recent', '2026-08-24T03:00:00.000Z')
    const blocked = archive('blocked', '2026-07-01T00:00:00.000Z')
    const active = repos.projects.insert({ name: 'active', path: 'C:\\active', source: 'manual' }).id
    const run = startRun(repos, blocked)
    repos.flowRuns.update(run.id, { worktreePath: 'C:\\blocked.worktrees\\checkout' })
    fillProject(repos, expired)

    expect(runRetention(db, { now, dryRun: true }).projectsDeleted).toBe(1)
    expect(repos.projects.byId(expired)).toBeDefined()

    expect(runRetention(db, { now }).projectsDeleted).toBe(1)
    expect(repos.projects.byId(expired)).toBeUndefined()
    expect(repos.projects.byId(recent)).toBeDefined()
    expect(repos.projects.byId(blocked)).toBeDefined()
    expect(repos.projects.byId(active)).toBeDefined()
  })

  it('counts the days an archived project has left, never below zero', () => {
    const archivedAt = '2026-09-01T12:00:00.000Z'
    const at = (iso: string) => archiveDaysLeft(archivedAt, Date.parse(iso))
    expect(at('2026-09-01T12:00:00.000Z')).toBe(30)
    expect(at('2026-09-28T12:00:00.000Z')).toBe(3)
    expect(at('2026-09-30T13:00:00.000Z')).toBe(1)
    expect(at('2026-10-01T12:00:00.000Z')).toBe(0)
    expect(at('2026-11-01T12:00:00.000Z')).toBe(0)
  })
})
