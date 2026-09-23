import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@shared/domain'

const volumes = vi.hoisted(() => [] as string[][])

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
  }),
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}))

vi.mock('@main/sessions/wslc-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/sessions/wslc-sandbox')>()
  return {
    ...actual,
    ensureSandboxImage: () => Promise.resolve(),
    ensureSandboxVolumes: (names: string[]) => {
      volumes.push([...names])
      return Promise.resolve()
    },
    removeNodeModulesVolume: () => {},
  }
})

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')
const { staleVolumes } = await import('@main/sessions/wslc-sandbox')

const dirs: string[] = []
afterEach(() => {
  volumes.length = 0
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const repos = createRepositories(openDatabase(':memory:'))
  const dir = mkdtempSync(join(tmpdir(), 'container-sessions-'))
  dirs.push(dir)
  const project = repos.projects.insert({ name: 'a', path: dir, source: 'manual' })
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const ended = (
    id: string,
    endedAt: string,
    homeVolumeOf: string | null = null,
    engine: Session['engine'] = 'claude',
  ): void => {
    const row: Session = {
      id,
      projectId: project.id,
      engine,
      sdkSessionId: `sdk-${id}`,
      status: 'done',
      statusDetail: null,
      branch: null,
      diffAdds: null,
      diffDels: null,
      usageUtilization: null,
      usageResetsAt: null,
      usageLimitType: null,
      startedAt: endedAt,
      endedAt: null,
      endReason: null,
      containerised: true,
      homeVolumeOf,
    }
    repos.sessions.insert(row)
    repos.sessions.update(id, { endedAt, endReason: 'completed' })
  }
  return { repos, project, manager, ended }
}

describe('a resumed container session', () => {
  it('keeps the Claude home volume of the first session in the chain, however many resumes later', async () => {
    const { repos, project, manager, ended } = setup()
    ended('first', '2026-09-01T01:00:00.000Z')
    ended('second', '2026-09-02T01:00:00.000Z', 'first')

    const third = await manager.startSession(project.id, true, undefined, { containerised: true })

    expect(volumes.at(-1)).toContain('switchboard-claude-home-first')
    expect(repos.sessions.byId(third.id)).toMatchObject({ containerised: true, homeVolumeOf: 'first' })
  })

  it('records that a session ran in a container even when it is not bypass', async () => {
    const { repos, project, manager } = setup()
    const inside = await manager.startSession(project.id, false, 'default', { containerised: true })
    const outside = await manager.startSession(project.id, false, 'default', { containerised: false })

    expect(repos.sessions.byId(inside.id)?.containerised).toBe(true)
    expect(repos.sessions.byId(outside.id)?.containerised).toBe(false)
  })
})

describe('a start that names no container choice', () => {
  it('follows Run in Container, so a handover into a sandboxed project stays in a container', async () => {
    const { repos, project, manager } = setup()
    repos.projects.setSessionMode(project.id, 'acceptEdits')
    repos.projects.setUseContainers(project.id, true)

    const handedOver = await manager.startSession(project.id)

    expect(manager.runsInContainer(handedOver.id)).toBe(true)
  })
})

describe('the engine a session starts on', () => {
  it('refuses Codex in a container or in bypass, which always runs in one', async () => {
    const { project, manager } = setup()

    await expect(
      manager.startSession(project.id, false, 'default', { containerised: true, engine: 'codex' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(manager.startSession(project.id, false, 'bypass', { engine: 'codex' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
  })

  it('resumes the last conversation of its own engine, never a Codex thread as a Claude one', async () => {
    const { repos, project, manager, ended } = setup()
    ended('claude-one', '2026-09-01T01:00:00.000Z')
    ended('codex-one', '2026-09-02T01:00:00.000Z', null, 'codex')

    const resumed = await manager.startSession(project.id, true, 'default', { containerised: false })

    expect(repos.sessions.byId(resumed.id)).toMatchObject({ engine: 'claude', homeVolumeOf: 'claude-one' })
  })

  it('keeps section sessions on Claude whatever the default engine is', async () => {
    const { repos, project, manager } = setup()
    repos.settings.set({ defaultEngine: 'codex' })

    const section = await manager.backgroundSessionFor(project.id, 'diagram')

    expect(repos.sessions.byId(section.id)?.engine).toBe('claude')
  })
})

describe('the stale volume sweep', () => {
  const now = Date.parse('2026-09-23T00:00:00.000Z')
  const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString()

  it('keeps a home volume while a later session of its chain ended recently', () => {
    const { repos, ended } = setup()
    ended('first', daysAgo(9))
    ended('second', daysAgo(1), 'first')
    ended('old', daysAgo(9))

    const stale = staleVolumes(
      ['switchboard-claude-home-first', 'switchboard-claude-home-old'],
      (owner) => repos.sessions.lastVolumeUse(owner),
      now,
    )

    expect(stale).toEqual(['switchboard-claude-home-old'])
  })

  it('never removes a volume this database knows nothing about, nor one still in use', () => {
    const stale = staleVolumes(
      ['switchboard-claude-home-someone-else', 'switchboard-node-modules-live', 'switchboard-nuget'],
      (owner) => (owner === 'live' ? { endedAt: null } : undefined),
      now,
    )

    expect(stale).toEqual([])
  })
})
