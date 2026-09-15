import type { SessionEvent, ToolActivityPayload } from './domain'

interface ActiveAgent {
  id: string
  name: string
  task: string
  label: string
  prompt: string
}

const AGENT_TOOLS = new Set(['Task', 'Agent'])

function agentOf(id: string, inputPreview: string): ActiveAgent {
  const field = (name: string): string | undefined =>
    inputPreview.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1]
  const unescape = (s: string): string =>
    s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const description = field('description')
  const type = field('subagent_type')
  const name = type ?? 'agent'
  const task = description ?? ''
  const label = description && type ? `${type} · ${description}` : (description ?? name)
  const rawPrompt = field('prompt')
  return { id, name, task, label, prompt: rawPrompt ? unescape(rawPrompt) : task }
}

const MAX_SCAN = 600

export function activeAgents(events: SessionEvent[]): ActiveAgent[] {
  const from = Math.max(0, events.length - MAX_SCAN)
  let turnStart = from
  for (let i = events.length - 1; i >= from; i--) {
    if (events[i].kind === 'result') {
      turnStart = i + 1
      break
    }
  }
  const agents: ActiveAgent[] = []
  for (let i = from; i < events.length; i++) {
    const event = events[i]
    if (event.kind !== 'tool_activity') continue
    const payload = event.payload as ToolActivityPayload
    if (!AGENT_TOOLS.has(payload.toolName) || payload.resultPreview !== undefined) continue
    if (!payload.background && i < turnStart) continue
    agents.push(agentOf(payload.toolUseId ?? event.id, payload.inputPreview))
  }
  return agents
}
