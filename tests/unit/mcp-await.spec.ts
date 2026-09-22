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
    onVerifyChanged: () => {},
    onSecurityChanged: () => {},
    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const hosted = (manager as unknown as { hosted: Map<string, { row: { mcpServers?: McpServer[] } }> }).hosted
  const entry = { row: {} as { mcpServers?: McpServer[] } }
  hosted.set('s1', entry)
  const report = (servers: McpServer[]): void => {
    entry.row.mcpServers = servers
  }
  return { manager, hosted, report }
}

describe('waiting for a session to report its MCP servers', () => {
  it('waits for a list that has not arrived yet, instead of reporting none', async () => {
    const { manager, report } = setup()
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
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('gives up on a server that never connects, rather than blocking the run', async () => {
    const { manager, report } = setup()
    report([
      { name: 'postgres-reporting', status: 'connected' },
      { name: 'oracle-claims', status: 'failed' },
    ])

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

    expect(await manager.connectedMcpServers('s1', ['postgres-reporting'], 300)).toEqual([])
  })
})
