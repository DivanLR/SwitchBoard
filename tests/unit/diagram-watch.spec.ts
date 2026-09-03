// Three real diagram requests died four to six seconds after being asked for,
// with the session still reading 'working' and no file ever written. The model
// was not at fault: a diagram is dispatched into a BACKGROUND session, and
// endIfIdleBackground closes one of those the moment it looks idle — where
// "idle" meant no verify watch, no API watch, no eval watch and an empty task
// queue. A drawing registered none of those, so a 'done' arriving from the
// session's previous turn was enough to have it stopped mid-draw.
//
// This pins both halves of the fix: a drawing counts as outstanding work, and it
// stops counting once the turn that produced it ends.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same shape as container-admission.spec.ts: the run loop is never exercised,
// so query() only has to satisfy what HostedSession.start() calls without
// awaiting, and an async-iterable that never yields stands in for a session that
// is up and doing nothing on its own.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  // Every session is now handed an in-process MCP server built at start-up
  // (inter-session.ts, the cross-project handover tool), so a mock of this
  // module without these two exports makes startSession throw before it
  // reaches anything these tests measure.
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

vi.mock('@main/sessions/wslc-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/sessions/wslc-sandbox')>()
  // Both pre-flights, not just the image one: a containerised start also
  // creates its named volumes up front now (wslc is not documented to create
  // them on first mount the way Docker did), and an unstubbed one would spawn
  // a real wslc on whatever machine runs this suite.
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
  for (const d of dirs.splice(0)) {
    try {
      // Retried, and then given up on. Ending a turn runs observeBranch, which
      // spawns git against this very directory, and Windows refuses to remove a
      // directory a live process still holds — so the first attempt races those
      // children and fails with EPERM. A leftover directory under %TEMP% is not
      // worth failing a suite about, least of all one whose subject is what the
      // session manager does at turn end.
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // The OS still has it. It is a temp directory; the OS can have it.
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
    onEvalsChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: (projectId) => changed.push(projectId),
    onApiRequests: () => {},
    onApiChanged: () => {},
    onProjectCommands: () => {},
    gate: (() => {}) as never,
  })
  return { db, repos, project, manager, changed }
}

/** The private turn-end path, reached the way a real session reaches it. */
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

    // The exact sequence the three real failures followed, and every step is
    // load-bearing. The session must have run a turn ALREADY (endIfIdleBackground
    // ignores one that never has, so a test without this passes for the wrong
    // reason and proves nothing) — that is the section's previous piece of work.
    finishTurn(manager, session.id)
    // Then the drawing is dispatched into that same idle session...
    manager.watchDiagram(session.id, 'a-diagram.html')
    // ...and the 'done' still in flight from the earlier turn lands.
    inner.handleStatusChange(inner.hosted.get(session.id), 'done')
    await new Promise((r) => setTimeout(r, 10))

    // Asserted on the CALL rather than on liveSessionIds(): stopSession races a
    // five-second grace period and the entry only leaves `hosted` when the run
    // loop exits, so the registry still lists a session that has been told to
    // stop. Whether it was told is the actual question.
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
    // The drawing turn ends: the file exists (or never will), and the watch is
    // spent. The guard must not outlive the work it was protecting, or a
    // background session holds one of only two container slots indefinitely.
    finishTurn(manager, session.id)
    inner.handleStatusChange(inner.hosted.get(session.id), 'done')
    await new Promise((r) => setTimeout(r, 10))

    // The note is asserted too, not just the call: a section session that closes
    // itself is the one close nobody asked for, so it has to say so or it reads as
    // a fault. See SessionManager.stopSession.
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

    // The turn that ends a drawing is the turn that wrote it, so the section is
    // told rather than left to find out on its own poll.
    expect(changed).toEqual([project.id])
    // Spent: a second turn is an ordinary turn and must not re-announce.
    finishTurn(manager, session.id)
    expect(changed).toEqual([project.id])
  })

  it('gives diagrams a session of their own, not the Tests one', async () => {
    const { project, manager } = setup()
    const tests = await manager.backgroundSessionFor(project.id, 'tests')
    const drawing = await manager.diagramSessionFor(project.id)
    // Sharing one session is what made a diagram queue behind a suite run.
    expect(drawing.id).not.toBe(tests.id)
  })

  it('gives every section kind its own session, and reuses within a kind', async () => {
    const { project, manager } = setup()
    const kinds = ['spec', 'tests', 'diff', 'cleanup'] as const
    const ids = new Set<string>()
    for (const kind of kinds) ids.add((await manager.backgroundSessionFor(project.id, kind)).id)
    // Four kinds, four sessions: a cleanup command no longer queues behind a
    // spec's implement phase, which is the whole point of the split.
    expect(ids.size).toBe(kinds.length)
    // Within one kind the live session is reused. A second verification pass
    // while the first is still running SHOULD queue; that is not the blocking
    // this removes, and starting a session per dispatch would never converge.
    const again = await manager.backgroundSessionFor(project.id, 'tests')
    expect(ids.has(again.id)).toBe(true)
  })

  it('runs a section natively until the project asks for containers', async () => {
    const { project, repos, manager } = setup()
    const inner = manager as unknown as { hosted: Map<string, { containerised: boolean }> }
    const native = await manager.backgroundSessionFor(project.id, 'spec')
    // Off by default (migration 026): five section kinds cannot share two
    // container slots, so the ceiling has to be opt-in rather than forced.
    expect(inner.hosted.get(native.id)?.containerised).toBe(false)

    repos.projects.setUseContainers(project.id, true)
    const boxed = await manager.backgroundSessionFor(project.id, 'cleanup')
    expect(inner.hosted.get(boxed.id)?.containerised).toBe(true)
  })

  it("names a session in the developer's own words, and clearing it restores the derived one", async () => {
    const { project, repos, manager } = setup()
    const session = await manager.backgroundSessionFor(project.id, 'tests')
    manager.renameSession(session.id, '  release smoke  ')
    expect(repos.sessions.byId(session.id)?.label).toBe('release smoke')
    // The live row too: the project list reads a running session from the
    // manager, so a rename that only touched the column would not show.
    expect(manager.liveSessionRow(session.id)?.label).toBe('release smoke')
    manager.renameSession(session.id, '   ')
    expect(repos.sessions.byId(session.id)?.label).toBe(null)
  })

  it('takes a fresh container per draw, and the machine-wide ceiling is what stops the next', async () => {
    const { project, repos, manager } = setup()
    // The ceiling only exists for a project that asked for containers; with the
    // switch off a drawing runs natively and nothing is rationed.
    repos.projects.setUseContainers(project.id, true)
    const first = await manager.diagramSessionFor(project.id)
    const second = await manager.diagramSessionFor(project.id)
    // No reuse: a second drawing never queues behind the first.
    expect(second.id).not.toBe(first.id)

    // And that is the whole budget. MAX_CONTAINERS is 2 for the MACHINE, not
    // per project, because every container shares one virtual machine — so two
    // drawings at once leave nothing for a verification pass, and the third
    // dispatch is refused rather than oversubscribing the VM and having the
    // kernel kill whichever container it likes. This is the cost of one
    // container per draw, asserted rather than left to be discovered.
    await expect(manager.diagramSessionFor(project.id)).rejects.toMatchObject({
      code: 'SANDBOX_FULL',
    })
  })
})
