// A verification run's database MCP servers must be the ones actually connected,
// and they arrive AFTER the session starts.
//
// `startSession` resolves as soon as the process is spawned; the server list comes
// later, on the SDK's init message. The verify.start handler starts a session and
// builds the prompt on the next line, so reading the live row immediately saw an
// empty list and produced a prompt naming no database server at all — while the
// developer had them configured and connecting. That is the bug these tests pin:
// a wait that only lasts as long as it can still change the answer.
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { SessionManager } from '@main/sessions/session-manager'
import type { McpServer } from '@shared/domain'

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onEvalsChanged: () => {},
    onVerifyChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  // The manager keeps live rows in a private map; a stand-in entry is enough,
  // because the wait reads exactly what onMcpServers writes there.
  const hosted = (manager as unknown as { hosted: Map<string, { row: { mcpServers?: McpServer[] } }> }).hosted
  const entry = { row: {} as { mcpServers?: McpServer[] } }
  hosted.set('s1', entry)
  /** What onMcpServers does when the SDK's init message lands. */
  const report = (servers: McpServer[]): void => {
    entry.row.mcpServers = servers
  }
  return { manager, hosted, report }
}

describe('waiting for a session to report its MCP servers', () => {
  it('waits for a list that has not arrived yet, instead of reporting none', async () => {
    const { manager, report } = setup()
    // The session is live but silent, exactly as it is right after startSession.
    setTimeout(() => report([{ name: 'postgres-reporting', status: 'connected' }]), 200)

    const found = await manager.connectedMcpServers('s1', ['postgres-reporting'], 3000)
    expect(found).toEqual(['postgres-reporting'])
  })

  it('waits for a server to leave pending rather than dropping it', async () => {
    const { manager, report } = setup()
    report([{ name: 'oracle-claims', status: 'pending' }])
    setTimeout(() => report([{ name: 'oracle-claims', status: 'connected' }]), 200)

    expect(await manager.connectedMcpServers('s1', ['oracle-claims'], 3000)).toEqual(['oracle-claims'])
  })

  it('returns at once, without waiting, when no server is configured', async () => {
    const { manager } = setup()
    const started = Date.now()
    expect(await manager.connectedMcpServers('s1', [], 3000)).toEqual([])
    // A project with no database servers must not pay a delay on every run.
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('gives up on a server that never connects, rather than blocking the run', async () => {
    const { manager, report } = setup()
    report([
      { name: 'postgres-reporting', status: 'connected' },
      { name: 'oracle-claims', status: 'failed' },
    ])

    // The one that is up is offered; the one that is not is left out, and the run
    // proceeds instead of hanging on it.
    const found = await manager.connectedMcpServers('s1', ['postgres-reporting', 'oracle-claims'], 400)
    expect(found).toEqual(['postgres-reporting'])
  })

  it('stops waiting when the session exits, instead of running out the clock', async () => {
    const { manager, hosted } = setup()
    setTimeout(() => hosted.delete('s1'), 150)

    const started = Date.now()
    expect(await manager.connectedMcpServers('s1', ['postgres-reporting'], 10_000)).toEqual([])
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('never offers a configured server the session did not report', async () => {
    const { manager, report } = setup()
    report([{ name: 'github', status: 'connected' }])

    // A name in settings that is not on this session must never reach the prompt:
    // the run would query a server that is not there.
    expect(await manager.connectedMcpServers('s1', ['postgres-reporting'], 300)).toEqual([])
  })
})
