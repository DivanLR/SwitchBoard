// Derives the subagents currently working from the session event stream.
// Subagents surface as Task/Agent tool_use events; one without its result half
// is still running. Only the current turn (after the last `result` event)
// counts, so agents orphaned by an interrupt never linger.
import type { SessionEvent, ToolActivityPayload } from './domain'

export interface ActiveAgent {
  /** The Task tool_use id — subagent-produced events carry it as payload.agentId. */
  id: string
  /** Agent name shown bold in the design's agent rows (the subagent type). */
  name: string
  /** What the agent is doing (its task description). */
  task: string
  /** name · task combined, for compact spots. */
  label: string
  /** The delegating prompt (possibly truncated) — opens the agent's chat view. */
  prompt: string
}

const AGENT_TOOLS = new Set(['Task', 'Agent'])

/** inputPreview is a truncated JSON preview; regex survives truncation where JSON.parse cannot. */
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

export function activeAgents(events: SessionEvent[]): ActiveAgent[] {
  let turnStart = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'result') {
      turnStart = i + 1
      break
    }
  }
  const agents: ActiveAgent[] = []
  for (const event of events.slice(turnStart)) {
    if (event.kind !== 'tool_activity') continue
    const payload = event.payload as ToolActivityPayload
    if (AGENT_TOOLS.has(payload.toolName) && payload.resultPreview === undefined) {
      agents.push(agentOf(payload.toolUseId ?? event.id, payload.inputPreview))
    }
  }
  return agents
}
