// Risk classification rule engine (FR-008a): ordered, first match wins,
// unmatched actions fail safe to high. Ships editable seeded defaults that
// follow the spec assumption: read-only inspection low, file modification
// medium, destructive or outward-facing actions high.
import type { RiskClassificationRule, RiskInputMatcher, RiskLevel } from '@shared/domain'
import { newId } from '@main/store/repositories'

export interface RiskEvaluation {
  risk: RiskLevel
  matchedRuleId: string | null
}

const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

export function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*'
        i += 1
      } else {
        pattern += '[^/\\\\]*'
      }
    } else if (ch === '?') {
      pattern += '.'
    } else if (REGEX_SPECIALS.has(ch)) {
      pattern += `\\${ch}`
    } else {
      pattern += ch
    }
  }
  return new RegExp(`^${pattern}$`, 'i')
}

function inputValue(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function matchesInput(matcher: RiskInputMatcher, input: Record<string, unknown>): boolean {
  const value = inputValue(input, matcher.field)
  switch (matcher.match) {
    case 'prefix':
      return value.startsWith(matcher.pattern)
    case 'glob':
      return globToRegExp(matcher.pattern).test(value)
    case 'regex':
      try {
        return new RegExp(matcher.pattern).test(value)
      } catch {
        return false
      }
  }
}

export function classifyRisk(
  rules: RiskClassificationRule[],
  toolName: string,
  input: Record<string, unknown>,
): RiskEvaluation {
  const ordered = [...rules].sort((a, b) => a.position - b.position)
  for (const rule of ordered) {
    if (rule.toolMatcher !== '*' && rule.toolMatcher !== toolName) continue
    if (rule.inputMatcher && !matchesInput(rule.inputMatcher, input)) continue
    return { risk: rule.risk, matchedRuleId: rule.id }
  }
  // Fail-safe: anything not matched by a rule is high risk (FR-008a).
  return { risk: 'high', matchedRuleId: null }
}

interface DefaultRuleSeed {
  toolMatcher: string
  inputMatcher?: RiskInputMatcher
  risk: RiskLevel
}

const DEFAULT_RULE_SEEDS: DefaultRuleSeed[] = [
  // Destructive commands first: order matters, first match wins.
  {
    toolMatcher: 'Bash',
    inputMatcher: {
      field: 'command',
      match: 'regex',
      pattern:
        '\\b(rm|rmdir|del|rd|format|mkfs|dd)\\b|Remove-Item|git\\s+(push\\s+.*--force|reset\\s+--hard|clean)',
    },
    risk: 'high',
  },
  // Read-only inspection commands.
  {
    toolMatcher: 'Bash',
    inputMatcher: {
      field: 'command',
      match: 'regex',
      pattern:
        '^(git\\s+(status|log|diff|show|branch)|ls|dir|cat|type|pwd|node\\s+--version|npm\\s+(ls|view))\\b',
    },
    risk: 'low',
  },
  // Package and build commands change the working tree but are routine.
  {
    toolMatcher: 'Bash',
    inputMatcher: {
      field: 'command',
      match: 'regex',
      pattern:
        '^(npm\\s+(install|run|test|ci)|npx\\s+|dotnet\\s+(build|test|run)|git\\s+(add|commit|fetch|pull))\\b',
    },
    risk: 'medium',
  },
  // Read-only tools.
  { toolMatcher: 'Read', risk: 'low' },
  { toolMatcher: 'Glob', risk: 'low' },
  { toolMatcher: 'Grep', risk: 'low' },
  { toolMatcher: 'NotebookRead', risk: 'low' },
  { toolMatcher: 'TodoWrite', risk: 'low' },
  // File modification.
  { toolMatcher: 'Edit', risk: 'medium' },
  { toolMatcher: 'Write', risk: 'medium' },
  { toolMatcher: 'NotebookEdit', risk: 'medium' },
  // Outward-facing actions are high per the spec assumption.
  { toolMatcher: 'WebFetch', risk: 'high' },
  { toolMatcher: 'WebSearch', risk: 'high' },
]

export function defaultRiskRules(): RiskClassificationRule[] {
  return DEFAULT_RULE_SEEDS.map((seed, index) => ({
    id: newId(),
    scope: 'global',
    position: index,
    toolMatcher: seed.toolMatcher,
    inputMatcher: seed.inputMatcher ?? null,
    risk: seed.risk,
    builtin: true,
  }))
}
