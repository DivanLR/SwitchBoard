// Swallow rule engine (FR-015a/017/018): ordered pattern rules classify
// low-value events with a noiseKind label. Classification is metadata only;
// rows persist untouched and the renderer groups consecutive tagged rows into
// expandable blocks. Errors and inbox-bound kinds are categorically exempt.
import type { EventKind, SessionEvent, SwallowRule } from '@shared/domain'
import { SWALLOWABLE_KINDS } from '@shared/domain'

export function displayTextOf(event: SessionEvent): string {
  switch (event.kind) {
    case 'tool_activity': {
      const p = event.payload as { toolName: string; inputPreview: string; resultPreview?: string }
      return [p.toolName, p.inputPreview, p.resultPreview ?? ''].join(' ')
    }
    case 'assistant_text':
    case 'raw_output': {
      const p = event.payload as { text?: string }
      return p.text ?? ''
    }
    default:
      return ''
  }
}

function isSwallowableKind(kind: string): kind is EventKind {
  return (SWALLOWABLE_KINDS as string[]).includes(kind)
}

/**
 * First match wins. Returns the noiseKind label or null (never swallowed).
 *
 * Rules used to carry a scope, so a project's own rules could take precedence over
 * global ones. Nothing ever created a project-scoped rule — not the shipped
 * defaults, not the editor — so the precedence tier sorted a list that only ever
 * had one tier in it. One flat ordering until a per-project rule actually exists.
 */
export function classifyNoise(rules: SwallowRule[], event: SessionEvent): string | null {
  if (!isSwallowableKind(event.kind)) return null
  const ordered = rules
    .filter(
      (rule) =>
        rule.enabled &&
        (rule.eventKindMatcher === '*' || rule.eventKindMatcher === event.kind),
    )
    .sort((a, b) => a.position - b.position)
  // These rules run on the main thread for every streamed event, so bound the
  // tested length: a pathological user pattern against a very long line (a
  // flooded build log) is the realistic freeze vector. This caps that case; a
  // catastrophic pattern on short input would still need RE2 or a worker, which
  // is deferred until a user actually reports a freeze.
  const text = displayTextOf(event).slice(0, 5000)
  for (const rule of ordered) {
    try {
      if (new RegExp(rule.pattern, 'im').test(text)) return rule.noiseKind
    } catch {
      // An invalid pattern never matches; the editor surfaces the problem.
    }
  }
  return null
}

interface DefaultSwallowSeed {
  /** Stable slug an override is keyed to. See the note in risk-rules.ts. */
  id: string
  eventKindMatcher: string
  pattern: string
  noiseKind: string
}

const DEFAULT_SWALLOW_SEEDS: DefaultSwallowSeed[] = [
  {
    id: 'build-output',
    eventKindMatcher: 'raw_output',
    pattern:
      '(Compiling|Building|Bundling|Restore complete|Determining projects to restore|webpack|vite v|tsc --|Creating an optimized|added \\d+ packages|npm warn|Resolving dependencies)',
    noiseKind: 'build output',
  },
  {
    // raw_output only: progress spam is a property of process/terminal output,
    // never of the model's narrative. A bare "45%" is NOT progress — matching it
    // on any kind hid genuine responses (e.g. /usage) from the clean view. Kept
    // to keyword-anchored indicators; see migration 009-progress-rule-scope,
    // which must stay in step with this pattern for existing databases.
    id: 'progress',
    eventKindMatcher: 'raw_output',
    pattern: '(\\.{4,}|Downloading|Installing|Fetching|Receiving objects|Progress:)',
    noiseKind: 'progress',
  },
  {
    id: 'file-inspection',
    eventKindMatcher: 'tool_activity',
    pattern: '^(Read|Glob|Grep|LS)\\b',
    noiseKind: 'file inspection',
  },
  {
    id: 'agent-bookkeeping',
    eventKindMatcher: 'tool_activity',
    pattern: '^(TodoWrite|NotebookRead)\\b',
    noiseKind: 'agent bookkeeping',
  },
]

export function defaultSwallowRules(): SwallowRule[] {
  return DEFAULT_SWALLOW_SEEDS.map((seed, index) => ({
    id: `builtin:${seed.id}`,
    position: index,
    eventKindMatcher: seed.eventKindMatcher,
    pattern: seed.pattern,
    noiseKind: seed.noiseKind,
    enabled: true,
  }))
}
