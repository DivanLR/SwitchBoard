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

export function classifyNoise(rules: SwallowRule[], event: SessionEvent): string | null {
  if (!isSwallowableKind(event.kind)) return null
  const text = displayTextOf(event).slice(0, 5000)
  for (const rule of rules) {
    if (rule.eventKindMatcher !== '*' && rule.eventKindMatcher !== event.kind) continue
    try {
      if (new RegExp(rule.pattern, 'im').test(text)) return rule.noiseKind
    } catch {}
  }
  return null
}

interface DefaultSwallowSeed {
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
  return DEFAULT_SWALLOW_SEEDS.map((seed) => ({ ...seed, id: `builtin:${seed.id}` }))
}
