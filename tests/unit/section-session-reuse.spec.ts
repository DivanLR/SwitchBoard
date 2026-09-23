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

    const first = await manager.backgroundSessionFor(project.id, 'flow')
    const second = await manager.backgroundSessionFor(project.id, 'flow')

    expect(second.id).toBe(first.id)
  })

  it('never crosses kinds, so a spec command cannot land in the flow session', async () => {
    const { project, manager } = setup()

    const flow = await manager.backgroundSessionFor(project.id, 'flow')
    const spec = await manager.backgroundSessionFor(project.id, 'spec')

    expect(spec.id).not.toBe(flow.id)
  })

  it('runs a diff comment on the worker model and leaves other sections on the main one', async () => {
    const { project, manager } = setup()

    const diff = await manager.backgroundSessionFor(project.id, 'diff')
    const flow = await manager.backgroundSessionFor(project.id, 'flow')

    const hosted = (
      manager as unknown as {
        hosted: Map<string, { session: { options: { mainModel?: string } } }>
      }
    ).hosted
    expect(hosted.get(diff.id)?.session.options.mainModel).toBe(DEFAULT_SETTINGS.workerModel)
    expect(hosted.get(flow.id)?.session.options.mainModel).toBe(DEFAULT_SETTINGS.intelligentModel)
  })

  it('runs a session in the worktree it is given, without moving the project', async () => {
    const { repos, project, manager } = setup()
    const worktree = mkdtempSync(join(tmpdir(), 'section-worktree-'))
    dirs.push(worktree)

    const session = await manager.startSession(project.id, false, undefined, undefined, {
      background: true,
      cwd: worktree,
    })

    expect(manager.workdirFor(session.id)).toBe(worktree)
    expect(repos.projects.byId(project.id)?.path).toBe(project.path)
  })

  it('never crosses projects', async () => {
    const { repos, project, manager } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'section-reuse-b-'))
    dirs.push(dir)
    const other = repos.projects.insert({ name: 'b', path: dir, source: 'manual' })

    const mine = await manager.backgroundSessionFor(project.id, 'flow')
    const theirs = await manager.backgroundSessionFor(other.id, 'flow')

    expect(theirs.id).not.toBe(mine.id)
  })
})
