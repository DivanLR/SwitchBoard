// Active-subagent derivation for the session view agent list.
import { describe, expect, it } from 'vitest'
import { activeAgents } from '@shared/agents'
import type { EventKind, EventPayloadMap, SessionEvent } from '@shared/domain'

let seq = 0
function event<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
  seq += 1
  return {
    id: `e${seq}`,
    sessionId: 's1',
    seq,
    kind,
    payload,
    noiseKind: null,
    createdAt: '2026-07-20T00:00:00.000Z',
  }
}

describe('activeAgents', () => {
  it('lists unresolved Task/Agent tool calls with type · description labels', () => {
    const events: SessionEvent[] = [
      event('tool_activity', {
        toolName: 'Task',
        inputPreview: '{"description":"Scan for bugs","prompt":"...","subagent_type":"Explore"}',
      }),
      event('tool_activity', {
        toolName: 'Agent',
        inputPreview: '{"description":"Fix lint","prompt":"very long prompt that got trunc…',
      }),
      event('tool_activity', { toolName: 'Bash', inputPreview: '{"command":"ls"}' }),
      event('tool_activity', {
        toolName: 'Task',
        inputPreview: '{"description":"Done already"}',
        resultPreview: '',
      }),
    ]
    const agents = activeAgents(events)
    expect(agents.map((a) => a.label)).toEqual(['Explore · Scan for bugs', 'Fix lint'])
    // name/task split feeds the design's agent rows (sidebar + stream card).
    expect(agents[0]).toMatchObject({ name: 'Explore', task: 'Scan for bugs' })
    expect(agents[1]).toMatchObject({ name: 'agent', task: 'Fix lint' })
  })

  it('ignores agents from finished turns and falls back to a generic label', () => {
    const events: SessionEvent[] = [
      event('tool_activity', { toolName: 'Task', inputPreview: '{"description":"Interrupted"}' }),
      event('result', { totalCostUsd: 0, usage: {}, durationMs: 1 }),
      event('tool_activity', { toolName: 'Task', inputPreview: '{"prompt":"no description…' }),
    ]
    expect(activeAgents(events).map((a) => a.label)).toEqual(['agent'])
  })

  it('keeps an unresolved background (task-channel) agent visible across a result', () => {
    const events: SessionEvent[] = [
      event('tool_activity', {
        toolName: 'Task',
        inputPreview: '{"description":"Research pricing"}',
        background: true,
      }),
      // The orchestrating turn finishes while the background agent runs on.
      event('result', { totalCostUsd: 0, usage: {}, durationMs: 1 }),
    ]
    expect(activeAgents(events).map((a) => a.task)).toEqual(['Research pricing'])
    // Once its close signal lands (resultPreview set), it drops off.
    const closed: SessionEvent[] = [
      event('tool_activity', {
        toolName: 'Task',
        inputPreview: '{"description":"Research pricing"}',
        background: true,
        resultPreview: 'done',
      }),
      event('result', { totalCostUsd: 0, usage: {}, durationMs: 1 }),
    ]
    expect(activeAgents(closed)).toEqual([])
  })
})
