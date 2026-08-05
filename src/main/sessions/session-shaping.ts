// Everything Switchboard injects into every hosted session: the system-prompt
// appends (output style and the cost-aware mode protocol) and the two mode
// subagents. One module because they are one decision per session start, applied
// at one call site in session-manager, and the mode instructions and the mode
// subagents must always describe the same pair.
//
// All the text here is authored, not third-party: it compresses or shapes the
// PROSE the model writes back without touching the user's prompts or the context
// the model reads. Code, commands, paths, identifiers, configuration and error
// text are preserved byte-for-byte by every level.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { ModelMode, TerseLevel } from '@shared/domain'
import { effortForRole, type ModelRole } from './model-routing'

// --- Terse output mode (Settings → Terminals) ---
// Inspired by the caveman skill's premise; the text is original.

const PRESERVE_CLAUSE =
  'Never abbreviate, reword, or omit code, shell commands, file paths, identifiers, ' +
  'configuration values, numeric results, or error messages. Reproduce all of those exactly. ' +
  'Never trade technical accuracy or a required step for brevity.'

// The instruction is prefixed with a hard directive so it is not diluted by the
// large Claude Code preset system prompt it is appended to. It is repeated at
// the end so it frames the response on both sides of the preset.
const HEADER =
  '## MANDATORY OUTPUT STYLE — THIS OVERRIDES DEFAULT VERBOSITY AND FORMATTING.\n' +
  'This is a hard constraint, not a preference. It takes precedence over any default ' +
  'tendency to write at length, add preamble, or restate the request. Apply it to EVERY ' +
  'response you produce for the rest of this session, including the very first one.\n'

const REINFORCE =
  '\nReminder: the output-style constraint above is mandatory for this and every later ' +
  'reply. If a reply reads like normal prose, it is too long — cut it.'

const LEVEL_INSTRUCTIONS: Record<TerseLevel, string> = {
  lite:
    HEADER +
    'Level: LITE. Trim filler, pleasantries, hedging, and preamble. Lead with the conclusion. ' +
    'Prefer short sentences. Keep enough words to stay clear. ' +
    PRESERVE_CLAUSE +
    REINFORCE,
  full:
    HEADER +
    'Level: TERSE (caveman). Compress prose hard. Telegraphic style: drop articles ' +
    '("the", "a", "an"), drop filler and hedging, drop pleasantries, never restate the ' +
    'question, no preamble, no closing summary unless asked. Use sentence fragments and ' +
    'bullet points, not full sentences. Conclusion first, then only load-bearing detail. ' +
    'Aim for well under half the words you would normally use. ' +
    PRESERVE_CLAUSE +
    REINFORCE,
  ultra:
    HEADER +
    'Level: ULTRA. Maximum prose compression. Telegraphic fragments only: no articles, no ' +
    'droppable pronouns, no filler, no restating the question, no preamble. One idea per line, ' +
    'bullets over sentences, symbols/arrows where clearer than words. ' +
    PRESERVE_CLAUSE +
    REINFORCE,
}

/** The append string for the given settings, or null when terse mode is off. */
export function terseSystemPromptAppend(options: {
  terseMode: boolean
  terseLevel: TerseLevel
}): string | null {
  if (!options.terseMode) return null
  return LEVEL_INSTRUCTIONS[options.terseLevel] ?? LEVEL_INSTRUCTIONS.full
}

// --- ADHD output style ---
// The compact ruleset the i-have-adhd project recommends embedding in
// instruction files, so sessions Switchboard spawns are shaped the same way as
// the global always-on plugin: action-first, numbered, no preamble. Gated on the
// SAME opt-in as that plugin, the flag file `$CLAUDE_CONFIG_DIR/.i-have-adhd-always`
// (default `~/.claude`), so one switch governs both.

const ADHD_APPEND =
  '## MANDATORY OUTPUT STYLE — ADHD READER. THIS OVERRIDES DEFAULT VERBOSITY.\n' +
  'A hard constraint on every response this session, including the first. Shape ' +
  'each reply so it can be acted on:\n' +
  '1. Lead with the answer or next action: command, path, or snippet first.\n' +
  '2. Number multi-step work; one bounded action per step.\n' +
  '3. End with one next action doable in under two minutes.\n' +
  '4. Finish the current issue before raising a new one.\n' +
  '5. Restate progress each turn ("step 3 of 5 done").\n' +
  '6. Give time estimates in concrete units, never "a bit".\n' +
  '7. After a change, show what now works.\n' +
  '8. Errors: state location, cause, and fix. No drama.\n' +
  '9. Cap lists at 5 items; rank rather than pad.\n' +
  '10. No preamble, no recaps, no closers.\n' +
  'Exceptions: explain fully when asked to explain; confirm before destructive ' +
  'actions; after three failed fixes, stop and name the doubtful assumption; if ' +
  'the request is ambiguous, ask one short question. Never trade a required step, ' +
  'code, command, path, or error text for brevity — reproduce those exactly.'

// --- Heavy subagent mode ---
// One thread is the wrong shape for work that decomposes: a five-file audit is
// five reads that could all be in flight at once. This append tells the session to
// spend agents rather than wall-clock wherever the task graph allows it.
//
// It states the cost openly rather than hiding it: fan-out spends more total
// tokens than one thread would, and the whole point of the setting is that the
// developer has chosen that trade. It also names the cases where fanning out is
// simply wrong, because an instruction to parallelise everything produces agents
// spawned to read one line.

const HEAVY_SUBAGENTS_APPEND =
  '## WORK SHAPE — FAN OUT BY DEFAULT\n' +
  'This session is configured for heavy subagent use. Prefer many agents working ' +
  'at once over one thread working through a list.\n' +
  '1. Before starting non-trivial work, decompose it into independent units and ' +
  'name them. Anything that does not depend on another unit\'s result runs now, ' +
  'not next.\n' +
  '2. Dispatch every independent unit in ONE batch so they run concurrently. Two ' +
  'sequential dispatches of one agent each is the failure this instruction exists ' +
  'to prevent.\n' +
  '3. Scale the fleet to the work: a broad audit, a multi-file refactor, a sweep ' +
  'across many call sites, or research with several angles all deserve as many ' +
  'agents as there are independent parts.\n' +
  '4. Give each agent a bounded task, the context it needs, and the exact shape of ' +
  'the result you want back, so nothing has to be re-run for a misunderstanding.\n' +
  '5. Verify in parallel too: findings worth acting on are worth an independent ' +
  'agent trying to refute them.\n' +
  'Do NOT fan out for a one-line change, a single file read, work whose steps each ' +
  'depend on the previous result, or anything where dispatching costs more than ' +
  'doing. Fan-out spends more total tokens than a single thread; that trade is the ' +
  'point of this setting, but it is only worth paying where the parts are genuinely ' +
  'independent.'

/** The fan-out append when heavy subagent mode is on, else null. */
export function heavySubagentSystemPromptAppend(enabled: boolean): string | null {
  return enabled ? HEAVY_SUBAGENTS_APPEND : null
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
    'A path in the developer\'s message has already been translated to its container path, so use ' +
    'it as given.'
  )
}

/** The ADHD append when the always-on flag file is present, else null. */
export function adhdSystemPromptAppend(): string | null {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return existsSync(join(dir, '.i-have-adhd-always')) ? ADHD_APPEND : null
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
