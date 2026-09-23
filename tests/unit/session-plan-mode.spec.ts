import { describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '@main/store/db'
import { createRepositories, newId, nowIso, type Repositories } from '@main/store/repositories'
import { HostedSession, resolvePermissionMode } from '@main/sessions/session'
import { DEFAULT_SESSION_MODE, SESSION_MODES } from '@shared/domain'
import type { Session } from '@shared/domain'

function setup(): { repos: Repositories; projectId: string; db: AppDatabase } {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  return { repos, projectId: project.id, db }
}

function sessionRow(projectId: string, planMode: boolean): Session {
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
    planMode,
  }
}

function hosted(onPlanModeChange: (inPlanMode: boolean) => void): HostedSession {
  return new HostedSession({
    sessionId: 's1',
    projectPath: 'C:\\a',
    claudeExecutablePath: 'C:\\claude.exe',
    input: 'hello',
    mode: 'auto',
    onPlanModeChange,
    sink: { append: () => ({ id: 'e1' }) } as never,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  } as never)
}

describe('the plan-mode flag a session starts with', () => {
  it('round-trips as a real boolean, and a normal session reads false', () => {
    const { repos, projectId } = setup()
    const planning = sessionRow(projectId, true)
    const ordinary = sessionRow(projectId, false)
    repos.sessions.insert(planning)
    expect(repos.sessions.byId(planning.id)?.planMode).toBe(true)

    repos.sessions.update(planning.id, { endedAt: nowIso(), endReason: 'completed' })
    repos.sessions.insert(ordinary)
    expect(repos.sessions.byId(ordinary.id)?.planMode).toBe(false)
  })

  it('survives the end of the session, so the restart toggle can pre-fill from it', () => {
    const { repos, projectId } = setup()
    const row = sessionRow(projectId, true)
    repos.sessions.insert(row)
    repos.sessions.update(row.id, { endedAt: nowIso(), endReason: 'completed' })
    expect(repos.sessions.latestEndedForProject(projectId)?.planMode).toBe(true)
  })

  it('reads rows written before the column existed as not planning', () => {
    const { repos, projectId, db } = setup()
    const row = sessionRow(projectId, true)
    repos.sessions.insert(row)
    db.prepare('UPDATE sessions SET planMode = NULL WHERE id = ?').run(row.id)
    expect(repos.sessions.byId(row.id)?.planMode).toBe(false)
  })

  it('never carries inPlanMode out of a row — that is the live mode, which no row holds', () => {
    const { repos, projectId } = setup()
    const row = sessionRow(projectId, true)
    repos.sessions.insert(row)
    expect(repos.sessions.byId(row.id)?.inPlanMode).toBeUndefined()
  })
})

describe('the mode a session spawns with', () => {
  it('passes every app mode through under the SDK name for it', () => {
    expect(resolvePermissionMode('default')).toBe('default')
    expect(resolvePermissionMode('auto')).toBe('auto')
    expect(resolvePermissionMode('acceptEdits')).toBe('acceptEdits')
    expect(resolvePermissionMode('plan')).toBe('plan')
  })

  it('covers every mode the app offers, so a new one cannot be added silently', () => {
    for (const { value } of SESSION_MODES) {
      expect(resolvePermissionMode(value)).toBeTruthy()
    }
    expect(SESSION_MODES.map((m) => m.value)).toEqual([
      'default',
      'dontAsk',
      'auto',
      'acceptEdits',
      'plan',
    ])
  })

  it('spells every mode exactly as the SDK does', () => {
    const sdk = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']
    for (const { value } of SESSION_MODES) {
      expect(sdk).toContain(resolvePermissionMode(value))
    }
    expect(new Set(SESSION_MODES.map((m) => resolvePermissionMode(m.value))).size).toBe(sdk.length)
  })

  it('keeps auto as the app default, so migration 022 changed no behaviour', () => {
    expect(DEFAULT_SESSION_MODE).toBe('auto')
    expect(resolvePermissionMode(DEFAULT_SESSION_MODE)).toBe('auto')
  })
})

describe('the live plan-mode switch', () => {
  it('asks the SDK for the mode the developer chose', () => {
    const asked: string[] = []
    const session = hosted(() => {})
    ;(session as unknown as { q: unknown }).q = {
      setPermissionMode: (mode: string) => {
        asked.push(mode)
        return Promise.resolve()
      },
    }

    session.setPlanMode(true)
    session.setPlanMode(false)
    expect(asked).toEqual(['plan', 'auto'])
  })

  it('is a no-op, not a crash, on a CLI too old to switch modes at runtime', () => {
    const session = hosted(() => {})
    ;(session as unknown as { q: unknown }).q = {
      setPermissionMode: () => Promise.reject(new Error('unknown method')),
    }
    expect(() => session.setPlanMode(true)).not.toThrow()
  })

  it('reports the mode the CLI states, including when it refused the one requested', () => {
    const seen: boolean[] = []
    const session = hosted((inPlanMode) => seen.push(inPlanMode))
    const handle = (message: unknown): void =>
      (session as unknown as { handleMessage: (m: unknown) => void }).handleMessage(message)

    handle({ type: 'system', subtype: 'init', permissionMode: 'default' })
    handle({ type: 'system', subtype: 'status', permissionMode: 'plan' })
    handle({ type: 'system', subtype: 'status', permissionMode: 'plan' })
    handle({ type: 'system', subtype: 'status', permissionMode: 'default' })
    handle({ type: 'assistant', message: { model: 'claude-opus-5' } })

    expect(seen).toEqual([false, true, false])
  })
})
