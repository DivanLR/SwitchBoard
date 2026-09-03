// Which section dispatches share a session, and which never do.
//
// backgroundSessionFor is the whole of that rule. Reuse is the default: a diff
// comment or a cleanup command is short, and a second one arriving while the
// first runs is not worth another CLI process. Two kinds are exempt, and both
// exemptions were paid for in complaints — a second drawing queueing behind the
// first, and (2026-08-22) a Spec Kit command queueing behind another that had
// minutes left to run, with nothing on screen saying so.
//
// Written against the manager rather than against the resolver's inputs, because
// the rule is one line and the value of a test here is that the line is wired to
// the path the sections actually call.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A never-yielding run loop: these tests only ask which session a dispatch
// resolves to, so no turn ever has to complete.
const pending: ((value: { value: undefined; done: true }) => void)[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  // Every session is now handed an in-process MCP server built at start-up
  // (inter-session.ts, the cross-project handover tool), so a mock of this
  // module without these two exports makes startSession throw before it
  // reaches anything these tests measure.
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
      // A temp directory the OS still holds open. The OS can have it.
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
    onEvalsChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onApiRequests: () => {},
    onApiChanged: () => {},
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
