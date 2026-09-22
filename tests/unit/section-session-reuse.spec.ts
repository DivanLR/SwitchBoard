import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/domain'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pending: ((value: { value: undefined; done: true }) => void)[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise((resolve) => pending.push(resolve as never)),
    }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(),
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
    ensureSandboxVolumes: () => Promise.resolve(),
  }
})

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')

const dirs: string[] = []
afterEach(() => {
  pending.length = 0
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
    }
  }
})

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const dir = mkdtempSync(join(tmpdir(), 'section-reuse-'))
  dirs.push(dir)
  const project = repos.projects.insert({ name: 'a', path: dir, source: 'manual' })
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onVerifyChanged: () => {},    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (() => {}) as never,
  })
  return { repos, project, manager }
}

describe('the session a section dispatch lands in', () => {
  it('gives every Spec Kit command a session of its own', async () => {
    const { project, manager } = setup()

    const first = await manager.backgroundSessionFor(project.id, 'spec')
    const second = await manager.backgroundSessionFor(project.id, 'spec')

    expect(first.id).toBeTruthy()
    expect(second.id).not.toBe(first.id)
  })

  it('still reuses a live session for the kinds that share one', async () => {
    const { project, manager } = setup()

    const first = await manager.backgroundSessionFor(project.id, 'cleanup')
    const second = await manager.backgroundSessionFor(project.id, 'cleanup')

    expect(second.id).toBe(first.id)
  })

  it('never crosses kinds, so a spec command cannot land in the cleanup session', async () => {
    const { project, manager } = setup()

    const cleanup = await manager.backgroundSessionFor(project.id, 'cleanup')
    const spec = await manager.backgroundSessionFor(project.id, 'spec')

    expect(spec.id).not.toBe(cleanup.id)
  })

  it('leaves a bypass default behind, so a section session stays off the container', async () => {
    const { repos, project, manager } = setup()
    repos.projects.setSessionMode(project.id, 'bypass')

    const session = await manager.backgroundSessionFor(project.id, 'diff')

    expect(session.bypassPermissions).toBe(false)
    const hosted = (manager as unknown as { hosted: Map<string, { containerised: boolean }> }).hosted
    expect(hosted.get(session.id)?.containerised).toBe(false)
  })

  it('runs a diff comment on the worker model and leaves other sections on the main one', async () => {
    const { project, manager } = setup()

    const diff = await manager.backgroundSessionFor(project.id, 'diff')
    const cleanup = await manager.backgroundSessionFor(project.id, 'cleanup')

    const hosted = (
      manager as unknown as {
        hosted: Map<string, { session: { options: { mainModel?: string } } }>
      }
    ).hosted
    expect(hosted.get(diff.id)?.session.options.mainModel).toBe(DEFAULT_SETTINGS.workerModel)
    expect(hosted.get(cleanup.id)?.session.options.mainModel).toBe(DEFAULT_SETTINGS.intelligentModel)
  })

  it('runs a session in the worktree it is given, without moving the project', async () => {
    const { repos, project, manager } = setup()
    const worktree = mkdtempSync(join(tmpdir(), 'section-worktree-'))
    dirs.push(worktree)

    const session = await manager.startSession(project.id, false, undefined, undefined, {
      background: true,
      engine: 'claude',
      cwd: worktree,
    })

    expect(manager.workdirFor(session.id)).toBe(worktree)
    expect(repos.projects.byId(project.id)?.path).toBe(project.path)
  })

  it('refuses a container session in a worktree, because the container mounts the project', async () => {
    const { project, manager } = setup()
    const worktree = mkdtempSync(join(tmpdir(), 'section-worktree-b-'))
    dirs.push(worktree)

    await expect(
      manager.startSession(project.id, false, undefined, undefined, {
        background: true,
        engine: 'claude',
        containerised: true,
        cwd: worktree,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('never crosses projects', async () => {
    const { repos, project, manager } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'section-reuse-b-'))
    dirs.push(dir)
    const other = repos.projects.insert({ name: 'b', path: dir, source: 'manual' })

    const mine = await manager.backgroundSessionFor(project.id, 'cleanup')
    const theirs = await manager.backgroundSessionFor(other.id, 'cleanup')

    expect(theirs.id).not.toBe(mine.id)
  })
})
