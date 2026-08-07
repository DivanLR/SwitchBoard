// Plan mode has two facts that must never be confused: how a session STARTED
// (planMode, a column) and where it is RIGHT NOW (inPlanMode, in memory only,
// because the mode can be switched at runtime and a stale column would be
// believed by the sidebar and by the next launch).
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
    bypassPermissions: false,
    planMode,
  }
}

/** A HostedSession with nothing real behind it: these cover the two methods that
 *  never touch the SDK's transport, so no query has to exist to drive them. */
function hosted(onPlanModeChange: (inPlanMode: boolean) => void): HostedSession {
  return new HostedSession({
    sessionId: 's1',
    projectPath: 'C:\\a',
    claudeExecutablePath: 'C:\\claude.exe',
    input: 'hello',
    // The fixture is cast, so this is not enforced by the compiler here: a real
    // session always carries a resolved mode, and leaving plan mode returns to it.
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
    // What an upgraded database looks like: the migration adds the column, and
    // every session that predates it carries NULL rather than 0.
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
  // The pair of booleans this replaces could ask for bypass AND plan at once,
  // which is a session the SDK cannot spawn, so the manager had to drop one
  // silently. One value cannot express the contradiction, and the old test for
  // "bypass wins over plan" has nothing left to assert.
  it('passes every app mode through under the SDK name for it', () => {
    expect(resolvePermissionMode('default')).toBe('default')
    expect(resolvePermissionMode('auto')).toBe('auto')
    expect(resolvePermissionMode('acceptEdits')).toBe('acceptEdits')
    expect(resolvePermissionMode('plan')).toBe('plan')
  })

  it('renames only bypass, which the SDK spells in full', () => {
    expect(resolvePermissionMode('bypass')).toBe('bypassPermissions')
  })

  it('covers every mode the app offers, so a new one cannot be added silently', () => {
    for (const { value } of SESSION_MODES) {
      expect(resolvePermissionMode(value)).toBeTruthy()
    }
    // All six the SDK can spawn in, in escalation order. The list was four for a
    // while, which is a picker deciding for you: 'dontAsk' in particular is the
    // only mode that REDUCES what can happen — nothing interrupts, and anything
    // not already approved is refused rather than asked.
    expect(SESSION_MODES.map((m) => m.value)).toEqual([
      'default',
      'dontAsk',
      'auto',
      'acceptEdits',
      'plan',
      'bypass',
    ])
  })

  it('spells every mode exactly as the SDK does, except bypass', () => {
    // The SDK union is 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' |
    // 'dontAsk' | 'auto'. A mode this app spells differently would be rejected at
    // spawn, and 'bypass' is the only rename the mapper is allowed to make.
    const sdk = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']
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
    // Back to the mode the session was started in, which is 'auto' for this
    // fixture — never to 'default'. One visit to planning must not turn asking
    // back on for the rest of the session, and must not change what it may do.
    expect(asked).toEqual(['plan', 'auto'])
  })

  it('is a no-op, not a crash, on a CLI too old to switch modes at runtime', () => {
    const session = hosted(() => {})
    ;(session as unknown as { q: unknown }).q = {
      setPermissionMode: () => Promise.reject(new Error('unknown method')),
    }
    expect(() => session.setPlanMode(true)).not.toThrow()
  })

  // The header must state the mode the CLI reports, never the one that was asked
  // for: a CLI that declined 'plan' would otherwise leave it claiming a
  // restriction that is not in force.
  it('reports the mode the CLI states, including when it refused the one requested', () => {
    const seen: boolean[] = []
    const session = hosted((inPlanMode) => seen.push(inPlanMode))
    const handle = (message: unknown): void =>
      (session as unknown as { handleMessage: (m: unknown) => void }).handleMessage(message)

    handle({ type: 'system', subtype: 'init', permissionMode: 'default' })
    handle({ type: 'system', subtype: 'status', permissionMode: 'plan' })
    // Unchanged: reported twice, announced once.
    handle({ type: 'system', subtype: 'status', permissionMode: 'plan' })
    handle({ type: 'system', subtype: 'status', permissionMode: 'default' })
    // Not a system message, so it says nothing about the mode.
    handle({ type: 'assistant', message: { model: 'claude-opus-5' } })

    expect(seen).toEqual([false, true, false])
  })
})
