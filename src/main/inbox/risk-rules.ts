// Risk classification rule engine (FR-008a): ordered, first match wins,
// unmatched actions fail safe to high. The defaults below follow the spec
// assumption: read-only inspection low, file modification medium, destructive or
// outward-facing actions high.
//
// These are DEFAULTS, not policy (PRODUCT.md Principle 3). The developer can
// switch any of them off, change its level, or add their own, and what they
// changed is stored separately — see inbox/rule-prefs.ts. This file stays the
// authority on what ships, which is what makes editing one a normal code change
// rather than a migration.
import type { RiskClassificationRule, RiskInputMatcher, RiskLevel } from '@shared/domain'

function inputValue(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function matchesInput(matcher: RiskInputMatcher, input: Record<string, unknown>): boolean {
  // Bound the tested length: this runs on the main thread on every permission
  // check, so a pathological user pattern against a long tool input cannot hang
  // the app. (See the note in swallow-rules for the residual short-input case.)
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
  const ordered = [...rules].sort((a, b) => a.position - b.position)
  for (const rule of ordered) {
    if (rule.toolMatcher !== '*' && rule.toolMatcher !== toolName) continue
    if (rule.inputMatcher && !matchesInput(rule.inputMatcher, input)) continue
    return rule.risk
  }
  // Fail-safe: anything not matched by a rule is high risk (FR-008a).
  return 'high'
}

interface DefaultRuleSeed {
  /**
   * Stable slug, never a generated id — a developer's override is keyed to it,
   * so renaming orphans that override. Retire a rule rather than rename it; see
   * rule-prefs.ts for why the defaults live in code, not a seeded table.
   */
  id: string
  toolMatcher: string
  inputMatcher?: RiskInputMatcher
  risk: RiskLevel
  /** Shown in the rules editor: what this rule is for, in the developer's terms. */
  label: string
}

const DEFAULT_RULE_SEEDS: DefaultRuleSeed[] = [
  // Destructive commands first: order matters, first match wins.
  {
    id: 'bash-destructive',
    label: 'Destructive shell commands',
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
    label: 'Read-only shell commands',
    toolMatcher: 'Bash',
    inputMatcher: {
      field: 'command',
      pattern:
        '^(git\\s+(status|log|diff|show|branch)|ls|dir|cat|type|pwd|node\\s+--version|npm\\s+(ls|view))\\b',
    },
    risk: 'low',
  },
  // Package and build commands change the working tree but are routine.
  {
    id: 'bash-build',
    label: 'Package and build commands',
    toolMatcher: 'Bash',
    inputMatcher: {
      field: 'command',
      pattern:
        '^(npm\\s+(install|run|test|ci)|npx\\s+|dotnet\\s+(build|test|run)|git\\s+(add|commit|fetch|pull))\\b',
    },
    risk: 'medium',
  },
  { id: 'tool-read', label: 'Read a file', toolMatcher: 'Read', risk: 'low' },
  { id: 'tool-glob', label: 'Find files by name', toolMatcher: 'Glob', risk: 'low' },
  { id: 'tool-grep', label: 'Search file contents', toolMatcher: 'Grep', risk: 'low' },
  { id: 'tool-notebook-read', label: 'Read a notebook', toolMatcher: 'NotebookRead', risk: 'low' },
  { id: 'tool-todowrite', label: 'Update the task list', toolMatcher: 'TodoWrite', risk: 'low' },
  { id: 'tool-edit', label: 'Edit a file', toolMatcher: 'Edit', risk: 'medium' },
  { id: 'tool-write', label: 'Write a file', toolMatcher: 'Write', risk: 'medium' },
  { id: 'tool-notebook-edit', label: 'Edit a notebook', toolMatcher: 'NotebookEdit', risk: 'medium' },
  { id: 'tool-webfetch', label: 'Fetch a URL', toolMatcher: 'WebFetch', risk: 'high' },
  { id: 'tool-websearch', label: 'Search the web', toolMatcher: 'WebSearch', risk: 'high' },
]

/** Label for a shipped rule, for the rules editor. Empty for a custom rule. */
export function riskRuleLabel(id: string): string {
  return DEFAULT_RULE_SEEDS.find((s) => `builtin:${s.id}` === id)?.label ?? ''
}

export function defaultRiskRules(): RiskClassificationRule[] {
  return DEFAULT_RULE_SEEDS.map((seed, index) => ({
    id: `builtin:${seed.id}`,
    scope: 'global',
    position: index,
    toolMatcher: seed.toolMatcher,
    inputMatcher: seed.inputMatcher ?? null,
    risk: seed.risk,
    builtin: true,
  }))
}
