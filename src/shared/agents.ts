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

/**
 * How far back to look. This function answers "which subagents are working right
 * now", which is a question about the current turn, so scanning the whole session
 * was never necessary — and it was expensive: a CPU profile of a flood-heavy
 * session put this function at 16.3% of self time, second only to Vue's own
 * reactive-proxy getter (42.9%), which it was itself driving by reading every
 * element of a deeply reactive array. It is called from two live computeds
 * (SessionView's workingAgents and the sidebar's parallelAgents), so both paid it
 * on every arriving event.
 *
 * ponytail: a fixed window rather than an index of turn boundaries. If a turn ever
 * runs longer than this many events, `turnStart` stays at the window's start, which
 * makes in-band agents from just before the window read as current — over-reporting
 * an agent rather than losing one. Build the index the day a turn is genuinely this
 * long.
 */
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
    // In-band agents only count within the current turn, so ones orphaned by an
    // interrupt never linger. Backgrounded agents (task channel) carry their own
    // close signal, so they stay active across a turn's result until it arrives.
    if (!payload.background && i < turnStart) continue
    agents.push(agentOf(payload.toolUseId ?? event.id, payload.inputPreview))
  }
  return agents
}
