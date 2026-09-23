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
    applyFlagSettings: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
  }),
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}))

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')

type Inner = {
  handleStatusChange: (entry: unknown, status: string) => void
  hosted: Map<string, { session: { options: { onTurnComplete: () => void } } }>
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
})

async function setup() {
  const repos = createRepositories(openDatabase(':memory:'))
  const dir = mkdtempSync(join(tmpdir(), 'flow-session-end-'))
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
    gate: (() => {}) as never,
  })
  const turnsEnded: string[] = []
  manager.setFlowHooks({
    onMarker: () => {},
    onSessionEnded: () => {},
    onVerifyReport: () => {},
    onTurnEnded: (sessionId) => turnsEnded.push(sessionId),
  })
  const session = await manager.startSession(project.id, false, undefined, undefined, {
    background: true,
  })
  manager.watchFlow(session.id)
  const stopped = vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined)
  const inner = manager as unknown as Inner
  const turnDone = (): void => {
    inner.hosted.get(session.id)?.session.options.onTurnComplete()
    inner.handleStatusChange(inner.hosted.get(session.id), 'done')
  }
  return { manager, session, stopped, turnDone, turnsEnded }
}

describe('ending the session of a finished Flow stage', () => {
  it('stops an idle stage session at once and stops watching it', async () => {
    const { manager, session, stopped } = await setup()

    manager.endFlowSession(session.id)

    expect(stopped).toHaveBeenCalledWith(session.id, expect.stringContaining('one piece of Flow work'))
    expect(manager.hasFlowWatch(session.id)).toBe(false)
  })

  it('lets a stage session finish the turn it is in, then stops it once, without reporting that turn', async () => {
    const { manager, session, stopped, turnDone, turnsEnded } = await setup()
    manager.sendMessage(session.id, 'Write the spec.')

    manager.endFlowSession(session.id)
    expect(stopped).not.toHaveBeenCalled()

    turnDone()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(stopped).toHaveBeenCalledTimes(1)
    expect(turnsEnded).toEqual([])
  })

  it('keeps a stage session that is still watched open between its turns', async () => {
    const { session, stopped, turnDone, turnsEnded } = await setup()

    turnDone()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(stopped).not.toHaveBeenCalled()
    expect(turnsEnded).toEqual([session.id])
  })
})
