import { describe, expect, it, vi } from 'vitest'
import type { ElicitationGate } from '@main/sessions/session'

const captured: { options?: Record<string, unknown> } = {}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    captured.options = args.options
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      supportedCommands: () => Promise.resolve([]),
      supportedModels: () => Promise.resolve([]),
    }
  },
}))

const { HostedSession } = await import('@main/sessions/session')

function start(elicit?: ElicitationGate) {
  const session = new HostedSession({
    sessionId: 's1',
    projectPath: 'C:\\a',
    mode: 'auto',
    elicit,
    sink: { append: () => ({ id: 'e' }), update: () => {} } as never,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  })
  session.start()
  const feed = (message: unknown): void => (session as unknown as { handleMessage(m: unknown): void }).handleMessage(message)
  return { feed, onElicitation: captured.options?.onElicitation as ((r: unknown, o: { signal: AbortSignal }) => Promise<unknown>) | undefined }
}

const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { model: 'claude', content: [{ type: 'tool_use', id, name, input }] },
})

const toolResult = (id: string) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})

function gate() {
  return {
    request: vi.fn(async () => ({ action: 'accept' as const })),
    completed: vi.fn(),
    toolFinished: vi.fn(),
  }
}

describe('MCP elicitation in a Claude session', () => {
  it('passes no callback without a gate, so nothing changes for a session that has none', () => {
    expect(start().onElicitation).toBeUndefined()
  })

  it('hands every elicitation to the gate with the latest in-flight call to that server', async () => {
    const g = gate()
    const { feed, onElicitation } = start(g)
    feed(toolUse('tu-1', 'mcp__ado__core_list_projects', { top: 1 }))
    feed(toolUse('tu-2', 'mcp__github__search', { q: 'x' }))
    feed(toolUse('tu-3', 'mcp__ado__wit_query', { project: 'Einstein Renewal' }))
    const signal = new AbortController().signal
    await onElicitation?.({ serverName: 'ado', message: 'Pick a project', mode: 'form' }, { signal })
    expect(g.request).toHaveBeenCalledWith({
      sessionId: 's1',
      request: { serverName: 'ado', message: 'Pick a project', mode: 'form' },
      signal,
      trigger: { toolUseId: 'tu-3', tool: 'mcp__ado__wit_query', input: { project: 'Einstein Renewal' } },
    })

    feed(toolResult('tu-3'))
    expect(g.toolFinished).toHaveBeenCalledWith('s1', 'tu-3')
    await onElicitation?.({ serverName: 'ado', message: 'Sign in', mode: 'url' }, { signal })
    expect(g.request).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: expect.objectContaining({ toolUseId: 'tu-1' }) }))

    feed(toolResult('tu-1'))
    await onElicitation?.({ serverName: 'ado', message: 'Sign in', mode: 'url' }, { signal })
    expect(g.request).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: null }))
  })

  it('forwards the completion of a url elicitation to the gate', () => {
    const g = gate()
    const { feed } = start(g)
    feed({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'ado', elicitation_id: 'e-1', uuid: 'u', session_id: 'x' })
    expect(g.completed).toHaveBeenCalledWith('s1', 'ado', 'e-1')
  })
})
