// Swallow rule engine (FR-015a/017/018): ordered pattern rules classify
// low-value events with a noiseKind label. Classification is metadata only;
// rows persist untouched and the renderer groups consecutive tagged rows into
// expandable blocks. Errors and inbox-bound kinds are categorically exempt.
import type { EventKind, SessionEvent, SwallowRule } from '@shared/domain'
import { SWALLOWABLE_KINDS } from '@shared/domain'
import { newId } from '@main/store/repositories'

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
 * First match wins; project-scope rules take precedence over global rules
 * (data-model.md). Returns the noiseKind label or null (never swallowed).
 */
export function classifyNoise(
  rules: SwallowRule[],
  event: SessionEvent,
  projectId: string,
): string | null {
  if (!isSwallowableKind(event.kind)) return null
  const applicable = rules.filter(
    (rule) =>
      rule.enabled &&
      (rule.scope === 'global' || rule.projectId === projectId) &&
      (rule.eventKindMatcher === '*' || rule.eventKindMatcher === event.kind),
  )
  const ordered = [
    ...applicable.filter((r) => r.scope === 'project').sort((a, b) => a.position - b.position),
    ...applicable.filter((r) => r.scope === 'global').sort((a, b) => a.position - b.position),
  ]
  const text = displayTextOf(event)
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
  eventKindMatcher: string
  pattern: string
  noiseKind: string
}

const DEFAULT_SWALLOW_SEEDS: DefaultSwallowSeed[] = [
  {
    eventKindMatcher: 'raw_output',
    pattern:
      '(Compiling|Building|Bundling|Restore complete|Determining projects to restore|webpack|vite v|tsc --|Creating an optimized|added \\d+ packages|npm warn|Resolving dependencies)',
    noiseKind: 'build output',
  },
  {
    eventKindMatcher: '*',
    pattern: '(\\d{1,3}\\s?%|\\.{4,}|Downloading|Installing|Fetching|Receiving objects|Progress:)',
    noiseKind: 'progress',
  },
  {
    eventKindMatcher: 'tool_activity',
    pattern: '^(Read|Glob|Grep|LS)\\b',
    noiseKind: 'file inspection',
  },
  {
    eventKindMatcher: 'tool_activity',
    pattern: '^(TodoWrite|NotebookRead)\\b',
    noiseKind: 'agent bookkeeping',
  },
]

export function defaultSwallowRules(): SwallowRule[] {
  return DEFAULT_SWALLOW_SEEDS.map((seed, index) => ({
    id: newId(),
    scope: 'global' as const,
    projectId: null,
    position: index,
    eventKindMatcher: seed.eventKindMatcher,
    pattern: seed.pattern,
    noiseKind: seed.noiseKind,
    enabled: true,
  }))
}
