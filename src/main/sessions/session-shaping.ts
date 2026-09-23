import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel, ModelMode } from '@shared/domain'

export const WORKER_AGENT = 'worker'

const norm = (m?: string): string | undefined => (m && m !== 'default' ? m : undefined)

export function modeAgents(options: {
  strongModel?: string
  cheapModel?: string
  mode?: ModelMode
  effort?: EffortLevel
}): Record<string, AgentDefinition> {
  if (options.mode === 'basic') return {}
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
      effort: options.effort,
    },
    [WORKER_AGENT]: {
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
      effort: options.effort,
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

export function heavySubagentModelMode(enabled: boolean, chosen: ModelMode): ModelMode {
  if (enabled) return 'orchestrator'
  return chosen === 'auto' ? 'advisor' : chosen
}

export function modesSystemPromptAppend(mode: ModelMode): string {
  const header =
    '## MODEL MODES — cost-aware execution protocol\n' +
    'Two subagents are available: `advisor` (strong model, expensive, consulted rarely) and ' +
    `\`${WORKER_AGENT}\` (cheap model, parallel-safe executor).\n`
  const advisor =
    'SCOPED WORK (single file/feature, mechanical turns): implement directly yourself. ' +
    "Consult `advisor` at the decision points its own description names, and follow its " +
    'guidance.\n'
  const orchestrator =
    'BROAD WORK (multi-step goals, many files, research/audit/migration): act as the ' +
    'orchestrator — plan first, split the goal into chunks with explicit inputs and expected ' +
    `outputs, delegate each chunk to \`${WORKER_AGENT}\` subagents (in parallel when independent), then ` +
    'review and integrate the results yourself. Keep your own turns for planning, review and ' +
    'the genuinely hard parts. Do not read large files wholesale when a worker can extract ' +
    'the relevant part; do not hand a worker an ambiguous chunk — tighten the spec first.\n' +
    'ONE SUMMARY, AT THE END. While delegated work or background tasks are still running, do ' +
    'NOT post a summary after each partial result — at most a single short status line ' +
    "(e.g. \"3 of 6 auditors back\"). Gather every result and post exactly ONE consolidated " +
    'summary once ALL delegated and background work has returned. Interim turns should read as ' +
    'progress, not conclusions.\n'
  const hygiene =
    `Token hygiene: prefer \`${WORKER_AGENT}\` delegation for templated or repetitive work; keep ` +
    'delegation specs short and precise; a worker that reports ambiguity gets a tighter spec, ' +
    'not a retry of the same one.'
  if (mode === 'basic') return ''
  if (mode === 'advisor') return header + advisor + hygiene
  if (mode === 'orchestrator') return header + orchestrator + hygiene
  return header + advisor + orchestrator + hygiene
}

export function sandboxSystemPromptAppend(
  mounts: readonly { container: string }[] = [],
  gitNote: string | null = null,
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
