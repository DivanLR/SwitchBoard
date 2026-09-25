import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { ModelMode } from '@shared/domain'

export const WORKER_AGENT = 'worker'

const norm = (m?: string): string | undefined => (m && m !== 'default' ? m : undefined)

export function modeAgents(options: {
  strongModel?: string
  cheapModel?: string
  mode?: ModelMode
}): Record<string, AgentDefinition> {
  const worker: AgentDefinition = {
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
  }
  if (options.mode === 'basic') return { [WORKER_AGENT]: worker }
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
    [WORKER_AGENT]: worker,
  }
}

export type PromptPattern = 'advisor' | 'none'

export function promptPattern(chosen: ModelMode): PromptPattern {
  return chosen === 'basic' ? 'none' : 'advisor'
}

export function modesSystemPromptAppend(mode: PromptPattern): string {
  const header =
    '## MODEL MODES — cost-aware execution protocol\n' +
    'Two subagents are available: `advisor` (strong model, expensive, consulted rarely) and ' +
    `\`${WORKER_AGENT}\` (cheap model, parallel-safe executor).\n`
  const advisor =
    'SCOPED WORK (single file/feature, mechanical turns): implement directly yourself. ' +
    "Consult `advisor` at the decision points its own description names, and follow its " +
    'guidance.\n'
  const hygiene =
    `Token hygiene: prefer \`${WORKER_AGENT}\` delegation for templated or repetitive work; keep ` +
    'delegation specs short and precise; a worker that reports ambiguity gets a tighter spec, ' +
    'not a retry of the same one.'
  if (mode === 'none') return ''
  return header + advisor + hygiene
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
