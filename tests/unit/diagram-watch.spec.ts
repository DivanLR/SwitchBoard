import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
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
  const dir = mkdtempSync(join(tmpdir(), 'diagram-watch-'))
  dirs.push(dir)
  const project = repos.projects.insert({ name: 'a', path: dir, source: 'manual' })
  const changed: string[] = []
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onVerifyChanged: () => {},    onDiagramsChanged: (projectId) => changed.push(projectId),
    onProjectCommands: () => {},
    gate: (() => {}) as never,
  })
  return { db, repos, project, manager, changed }
}

function finishTurn(manager: unknown, sessionId: string): void {
  const m = manager as { hosted: Map<string, { session: { options: { onTurnComplete: () => void } } }> }
  m.hosted.get(sessionId)?.session.options.onTurnComplete()
}

describe('a diagram in flight keeps its session open', () => {
  it('does not close a background session that is still drawing', async () => {
    const { project, manager } = setup()
    const session = await manager.diagramSessionFor(project.id)
    const inner = manager as unknown as {
      handleStatusChange: (entry: unknown, s: string) => void
      hosted: Map<string, unknown>
    }
    const stopped = vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined)

    finishTurn(manager, session.id)
    manager.watchDiagram(session.id, 'a-diagram.html')
    inner.handleStatusChange(inner.hosted.get(session.id), 'done')
    await new Promise((r) => setTimeout(r, 10))

    expect(stopped).not.toHaveBeenCalled()
  })

  it('closes it once the drawing turn has ended, so a container is not held for ever', async () => {
    const { project, manager } = setup()
    const session = await manager.diagramSessionFor(project.id)
    const inner = manager as unknown as {
      handleStatusChange: (entry: unknown, s: string) => void
      hosted: Map<string, unknown>
    }
    const stopped = vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined)

    manager.watchDiagram(session.id, 'a-diagram.html')
    finishTurn(manager, session.id)
    inner.handleStatusChange(inner.hosted.get(session.id), 'done')
    await new Promise((r) => setTimeout(r, 10))

    expect(stopped).toHaveBeenCalledWith(
      session.id,
      expect.stringContaining('closed itself when that work finished'),
    )
  })

  it('tells the section the moment the drawing turn ends, and releases the watch', async () => {
    const { project, manager, changed } = setup()
    const session = await manager.diagramSessionFor(project.id)
    manager.watchDiagram(session.id, 'a-diagram.html')

    finishTurn(manager, session.id)

    expect(changed).toEqual([project.id])
    finishTurn(manager, session.id)
    expect(changed).toEqual([project.id])
  })

  it('gives diagrams a session of their own, not the Tests one', async () => {
    const { project, manager } = setup()
    const tests = await manager.backgroundSessionFor(project.id, 'tests')
    const drawing = await manager.diagramSessionFor(project.id)
    expect(drawing.id).not.toBe(tests.id)
  })

  it('gives every section kind its own session, and reuses within a kind', async () => {
    const { project, manager } = setup()
    const kinds = ['tests', 'diff', 'flow'] as const
    const ids = new Set<string>()
    for (const kind of kinds) ids.add((await manager.backgroundSessionFor(project.id, kind)).id)
    expect(ids.size).toBe(kinds.length)
    const again = await manager.backgroundSessionFor(project.id, 'tests')
    expect(ids.has(again.id)).toBe(true)
  })

  it("names a session in the developer's own words, and clearing it restores the derived one", async () => {
    const { project, repos, manager } = setup()
    const session = await manager.backgroundSessionFor(project.id, 'tests')
    manager.renameSession(session.id, '  release smoke  ')
    expect(repos.sessions.byId(session.id)?.label).toBe('release smoke')
    expect(manager.liveSessionRow(session.id)?.label).toBe('release smoke')
    manager.renameSession(session.id, '   ')
    expect(repos.sessions.byId(session.id)?.label).toBe(null)
  })
})
