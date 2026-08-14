// Everything Switchboard injects into every hosted session: the system-prompt
// appends (sandbox notes, heavy-subagent mode and the cost-aware mode protocol)
// and the two mode subagents. One module because they are one decision per session start, applied
// at one call site in session-manager, and the mode instructions and the mode
// subagents must always describe the same pair.
//
// All the text here is authored, not third-party.
//
// The terse output mode and the ADHD output style were removed on 2026-08-14 at
// the owner's direction: a standing answer-style preference now governs prose, so
// a per-session instruction telling the model how to write was redundant. The
// ADHD accessor was already inert, gated on a flag file created by a plugin that
// is no longer installed.
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { ModelMode } from '@shared/domain'
import { effortForRole, type ModelRole } from './model-routing'

// --- Heavy subagent mode ---
// One thread is the wrong shape for work that decomposes: a five-file audit is
// five reads that could all be in flight at once. This append tells the session to
// spend agents rather than wall-clock wherever the task graph allows it.
//
// The first version of this text read as balanced advice and was reported as not
// working. Two things were wrong with it, and both are fixed below.
//
// The GUARD WAS WIDER THAN THE INSTRUCTION. It excused a model from fanning out
// for "work whose steps each depend on the previous result" and "anything where
// dispatching costs more than doing" — two clauses that fit almost any task if
// you squint, and a model reading its own plan will squint. The exclusions are
// now a short closed list of things that are genuinely one action.
//
// And it CONTRADICTED THE MODE PROTOCOL sitting a few paragraphs above it, which
// in Advisor mode says in as many words to implement scoped work yourself. Two
// instructions, one telling the loop to delegate and one telling it not to. That
// is resolved at the call site rather than here: with this setting on, the mode
// protocol is pinned to Orchestrator so the two texts agree (see
// heavySubagentModelMode).

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
  'the result you want back, so nothing is re-run over a misunderstanding.\n' +
  '5. Verify in parallel too: a finding worth acting on is worth an independent agent ' +
  'trying to refute it.\n' +
  'The ONLY work exempt from this is work that is a single action: one edit to one ' +
  'file, one command, one lookup, or a chain where every step literally needs the ' +
  'previous step\'s output. "It would be quicker to just do it" is not an exemption — ' +
  'fan-out spends more tokens than one thread, and paying that for speed is precisely ' +
  'the trade this setting was switched on to make.'

/** The fan-out append when heavy subagent mode is on, else null. */
export function heavySubagentSystemPromptAppend(enabled: boolean): string | null {
  return enabled ? HEAVY_SUBAGENTS_APPEND : null
}

/**
 * The mode protocol to teach when heavy subagent mode is on.
 *
 * Orchestrator, whatever the Models tab says, because Advisor's own text ("SCOPED
 * WORK … implement directly yourself") is the opposite instruction and sits in the
 * same system prompt. Leaving both in was most of why the setting read as doing
 * nothing: the model had licence either way and took the cheaper one.
 *
 * The Models tab still decides which MODEL runs the loop; this only decides which
 * protocol the loop is taught. Those are separate levers (see mainLoopModel).
 */
export function heavySubagentModelMode(enabled: boolean, chosen: ModelMode): ModelMode {
  return enabled ? 'orchestrator' : chosen
}

// --- Container layout (bypass sessions) ---
// A bypass session's CLI runs inside a Linux container, so the project and the
// REFS folders are at container paths. Message text is translated on the way in
// (toContainerPaths), but the agent still has to know the shape of what it is
// standing in — without this it treats a missing /mnt/c as "the repo is
// unreachable" and asks the developer to git clone something already mounted.

/** The container-layout append for a bypass session, else null. `gitNote` is
 *  gitNotice()'s verdict — stated here so the agent never reads a missing .git
 *  at /workspace as "the history was deleted". */
export function sandboxSystemPromptAppend(
  mounts: readonly { container: string }[] = [],
  gitNote: string | null = null,
  /** True when this project's node_modules is a container-private volume. */
  nodeModulesVolume = false,
): string | null {
  if (mounts.length === 0) return null
  const refs = mounts.filter((m) => m.container !== '/workspace').map((m) => m.container)
  return (
    '## ENVIRONMENT — you are inside a Linux container, not on the host\n' +
    'This session runs in a disposable container. The host is Windows; its drive is NOT mounted, ' +
    'so `/mnt/c/...`, `C:\\...` and any other host path do not exist here and never will.\n' +
    '- `/workspace` — this project, read-write. Your cwd.\n' +
    (refs.length > 0
      ? `- ${refs.map((r) => `\`${r}\``).join(', ')} — the referenced folders (REFS), read-only. ` +
        'They are ALREADY here: read them directly. Never ask for a git clone or a pasted file ' +
        'for anything under these paths, and never conclude a referenced repo is unreachable ' +
        'before listing them.\n' +
        'They sit OUTSIDE /workspace, so a repo-wide search from your cwd does not reach them and ' +
        '"0 hits repo-wide" proves nothing about them. When a search is about where something is ' +
        'defined, used, or called, pass them explicitly:\n' +
        `  rg -n "pattern" /workspace ${refs.join(' ')}\n`
      : '- No referenced folders are mounted. REFS chips added after the session started only ' +
        'mount from the next session, so ask for a restart rather than a clone.\n') +
    (gitNote ? `- Git: ${gitNote}\n` : '') +
    (nodeModulesVolume
      ? '- `/workspace/node_modules` is a volume of THIS session, not the host\'s folder and not ' +
        'shared with any other session. The host installed its dependencies on Windows, and ' +
        'those binaries cannot run here. If a command fails on a missing module, run `npm ci` ' +
        '(or `npm install`) once; the download cache is shared, so it is faster than it looks. ' +
        'Doing so is SAFE: it cannot disturb the host checkout, and no other session is ' +
        'installing into the same folder.\n'
      : '') +
    'A path in the developer\'s message has already been translated to its container path, so use ' +
    'it as given.'
  )
}

// --- Advisor / Orchestrator model modes (the Fable-5 era cost patterns) ---
// Pair a strong model with a cheap one so most tokens bill at the cheaper rate.
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
// native levers: ONE main-loop model per session plus per-subagent models. The
// main loop never switches model mid-session — that would invalidate every
// prompt-cache tier — so the other tier is always reached through a subagent,
// which carries its own context (see mainLoopModel in model-routing).

const norm = (m?: string): string | undefined => (m && m !== 'default' ? m : undefined)

// Effort per agent ROLE: the advisor reasons ('xhigh'), the worker executes
// ('low'). A mechanical executor given an explicit input and expected output
// gains nothing from depth, and paying for it is what erases the saving the
// cheap tier exists for. undefined = inherit the default.
const effortFor = (role: ModelRole, model?: string): 'xhigh' | 'low' | undefined =>
  effortForRole(role, norm(model)) ?? undefined

/**
 * The two mode subagents, injected into every session so the protocol below
 * can reach for them regardless of which model runs a given turn.
 */
export function modeAgents(options: {
  /** The strong model (Settings "Intelligent model"); default = account model. */
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
      effort: effortFor('advisor', options.strongModel),
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
      effort: effortFor('worker', options.cheapModel),
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
    "Consult `advisor` at the decision points its own description names, and follow its " +
    'guidance.\n'
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
