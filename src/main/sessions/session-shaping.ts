import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel } from '@shared/domain'

export const WORKER_AGENT = 'worker'

export function workerAgents(effort: EffortLevel): Record<string, AgentDefinition> {
  return {
    [WORKER_AGENT]: {
      description:
        'General worker for any delegated part of a task: research, edits, reviews and ' +
        'verification. Use it for every subagent unless a specialised agent fits better.',
      prompt:
        'You are a worker subagent. Do the bounded task you were given, and return the ' +
        'result in the exact shape the task asks for.',
      effort,
    },
  }
}

const HEAVY_SUBAGENTS_APPEND =
  '## WORK SHAPE — DIVIDE AND CONQUER. THIS OVERRIDES YOUR DEFAULT TENDENCY TO WORK ALONE.\n' +
  'This session is configured for heavy subagent use, and that is a hard directive for ' +
  'every turn, not a hint. Use as many dynamic subagents as the work allows, split the ' +
  'work between them, and get it done as fast as parallelism permits.\n' +
  '1. Before starting any non-trivial work, decompose it and NAME the parts. Anything ' +
  "that does not need another part's result runs NOW, not next.\n" +
  '2. Dispatch every independent part in ONE batch so they run concurrently. Two ' +
  'sequential dispatches of one agent each is the exact failure mode to avoid.\n' +
  '3. Scale the fleet to the work, not to your comfort. A broad audit, a multi-file ' +
  'refactor, a sweep across call sites, or research with several angles each deserve ' +
  'as many agents as there are independent parts.\n' +
  '4. Give each agent a bounded task, the context it needs, and the exact shape of ' +
  'the result you want back, so nothing is re-run over a misunderstanding. Dispatch ' +
  `each part to the "${WORKER_AGENT}" agent (subagent_type "${WORKER_AGENT}") unless a ` +
  'specialised agent fits that part better.\n' +
  '5. Verify in parallel too: a finding worth acting on is worth an independent agent ' +
  'trying to refute it.\n' +
  'The ONLY work exempt from this is work that is a single action: one edit to one ' +
  'file, one command, one lookup, or a chain where every step literally needs the ' +
  'previous step\'s output. "It would be quicker to just do it" is not an exemption — ' +
  'fan-out spends more tokens than one thread, and paying that for speed is precisely ' +
  'the trade this setting was switched on to make.'

export function heavySubagentSystemPromptAppend(enabled: boolean): string | null {
  return enabled ? HEAVY_SUBAGENTS_APPEND : null
}
