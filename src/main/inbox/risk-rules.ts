import type { RiskClassificationRule, RiskInputMatcher, RiskLevel } from '@shared/domain'

function inputValue(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function matchesInput(matcher: RiskInputMatcher, input: Record<string, unknown>): boolean {
  const value = inputValue(input, matcher.field).slice(0, 5000)
  try {
    return new RegExp(matcher.pattern).test(value)
  } catch {
    return false
  }
}

export function classifyRisk(
  rules: RiskClassificationRule[],
  toolName: string,
  input: Record<string, unknown>,
): RiskLevel {
  for (const rule of rules) {
    if (rule.toolMatcher !== '*' && rule.toolMatcher !== toolName) continue
    if (rule.inputMatcher && !matchesInput(rule.inputMatcher, input)) continue
    return rule.risk
  }
  return 'high'
}

interface DefaultRuleSeed {
  id: string
  toolMatcher: string
  inputMatcher?: RiskInputMatcher
  risk: RiskLevel
}

const DEFAULT_RULE_SEEDS: DefaultRuleSeed[] = [
  {
    id: 'bash-destructive',
    toolMatcher: 'Bash',
    inputMatcher: {
      field: 'command',
      pattern:
        '\\b(rm|rmdir|del|rd|format|mkfs|dd)\\b|Remove-Item|git\\s+(push\\s+.*--force|reset\\s+--hard|clean)',
    },
    risk: 'high',
  },
  {
    id: 'bash-readonly',
    toolMatcher: 'Bash',
    inputMatcher: {
      field: 'command',
      pattern:
        '^(git\\s+(status|log|diff|show|branch)|ls|dir|cat|type|pwd|node\\s+--version|npm\\s+(ls|view))\\b',
    },
    risk: 'low',
  },
  {
    id: 'bash-build',
    toolMatcher: 'Bash',
    inputMatcher: {
      field: 'command',
      pattern:
        '^(npm\\s+(install|run|test|ci)|npx\\s+|dotnet\\s+(build|test|run)|git\\s+(add|commit|fetch|pull))\\b',
    },
    risk: 'medium',
  },
  { id: 'tool-read', toolMatcher: 'Read', risk: 'low' },
  { id: 'tool-glob', toolMatcher: 'Glob', risk: 'low' },
  { id: 'tool-grep', toolMatcher: 'Grep', risk: 'low' },
  { id: 'tool-notebook-read', toolMatcher: 'NotebookRead', risk: 'low' },
  { id: 'tool-todowrite', toolMatcher: 'TodoWrite', risk: 'low' },
  { id: 'tool-edit', toolMatcher: 'Edit', risk: 'medium' },
  { id: 'tool-write', toolMatcher: 'Write', risk: 'medium' },
  { id: 'tool-notebook-edit', toolMatcher: 'NotebookEdit', risk: 'medium' },
  { id: 'tool-webfetch', toolMatcher: 'WebFetch', risk: 'high' },
  { id: 'tool-websearch', toolMatcher: 'WebSearch', risk: 'high' },
]

export function defaultRiskRules(): RiskClassificationRule[] {
  return DEFAULT_RULE_SEEDS.map((seed) => ({
    id: `builtin:${seed.id}`,
    toolMatcher: seed.toolMatcher,
    inputMatcher: seed.inputMatcher ?? null,
    risk: seed.risk,
  }))
}
