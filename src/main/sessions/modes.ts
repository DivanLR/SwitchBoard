// Advisor / Orchestrator model modes (the Fable-5 era cost patterns): pair a
// strong model with a cheap one so most tokens bill at the cheaper rate.
//
//   Advisor      — the CHEAP model runs the main loop and does the mechanical
//                  work; a strong-model `advisor` subagent is consulted rarely
//                  (approach, stuck, final review). For scoped coding tasks.
//   Orchestrator — the STRONG model runs the main loop, decomposes the goal,
//                  and delegates well-scoped chunks to cheap `worker`
//                  subagents (parallel when independent). For broad,
//                  multi-step or research-shaped goals.
//
// The Messages-API advisor tool (advisor_20260301) is not wireable through a
// Claude Code session, so both patterns are expressed with the Agent SDK's
// native levers: per-turn main-loop model switching + per-subagent models.
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { ModelMode } from '@shared/domain'

const norm = (m?: string): string | undefined => (m && m !== 'default' ? m : undefined)

/**
 * The two mode subagents, injected into every session so the protocol below
 * can reach for them regardless of which model runs a given turn.
 */
export function modeAgents(options: {
  /** The strong model (Settings "Implementation model"); default = account model. */
  strongModel?: string
  /** The cheap model (Settings worker model); default = inherit the main model. */
  cheapModel?: string
}): Record<string, AgentDefinition> {
  return {
    advisor: {
      description:
        'Strategic advisor on the strong model. Consult BEFORE starting a non-trivial change ' +
        '(approach + risks), when stuck after two failed attempts, or for a final review of a ' +
        'plan or diff. Expensive — at most 3 consults per task.',
      prompt:
        'You are the ADVISOR: a senior architect consulted sparingly for strategy, not labour. ' +
        'Answer decision-first and concise: the recommended approach, the top risks or hidden ' +
        'traps, and what to verify afterwards. Point at specific files/functions when it matters. ' +
        'Do NOT write full implementations — sketches and diffs of the tricky part only. ' +
        'If the question is under-specified, state the assumption you would proceed on.',
      model: norm(options.strongModel),
    },
    worker: {
      description:
        'Mechanical executor on the cheap model for well-scoped chunks with CLEAR inputs and ' +
        'outputs: file edits, renames, boilerplate, running tests/builds, extracting or ' +
        'summarising parts of files. Parallel-safe — fan out independent chunks in one turn.',
      prompt:
        'You are a WORKER: execute exactly the scoped chunk you were given. Expect an explicit ' +
        'input (files/paths/content) and an explicit expected output; deliver precisely that, ' +
        'raw and complete, no commentary. If the input is ambiguous or does not match what the ' +
        'instructions assume, STOP and return one short clarifying question instead of guessing.',
      model: norm(options.cheapModel),
    },
  }
}

/**
 * System-prompt append teaching the session both protocols. Static text (never
 * interpolated) so it stays prompt-cache friendly. The per-turn model routing
 * in session.ts decides which tier runs the loop; these instructions make
 * either tier behave correctly for its workload.
 */
export function modesSystemPromptAppend(mode: ModelMode): string {
  const header =
    '## MODEL MODES — cost-aware execution protocol\n' +
    'Two subagents are available: `advisor` (strong model, expensive, consulted rarely) and ' +
    '`worker` (cheap model, parallel-safe executor).\n'
  const advisor =
    'SCOPED WORK (single file/feature, mechanical turns): implement directly yourself. ' +
    'Consult `advisor` at most 3 times per task, only at decision points — the approach before ' +
    'a non-trivial change, after two failed attempts, or a final review. Follow its guidance.\n'
  const orchestrator =
    'BROAD WORK (multi-step goals, many files, research/audit/migration): act as the ' +
    'orchestrator — plan first, split the goal into chunks with explicit inputs and expected ' +
    'outputs, delegate each chunk to `worker` subagents (in parallel when independent), then ' +
    'review and integrate the results yourself. Keep your own turns for planning, review and ' +
    'the genuinely hard parts. Do not read large files wholesale when a worker can extract ' +
    'the relevant part; do not hand a worker an ambiguous chunk — tighten the spec first.\n' +
    'ONE SUMMARY, AT THE END. While delegated work or background tasks are still running, do ' +
    'NOT post a summary after each partial result — at most a single short status line ' +
    "(e.g. \"3 of 6 auditors back\"). Gather every result and post exactly ONE consolidated " +
    'summary once ALL delegated and background work has returned. Interim turns should read as ' +
    'progress, not conclusions.\n'
  const hygiene =
    'Token hygiene: prefer `worker` delegation for templated or repetitive work; keep ' +
    'delegation specs short and precise; a worker that reports ambiguity gets a tighter spec, ' +
    'not a retry of the same one.'
  if (mode === 'advisor') return header + advisor + hygiene
  if (mode === 'orchestrator') return header + orchestrator + hygiene
  return header + advisor + orchestrator + hygiene
}
