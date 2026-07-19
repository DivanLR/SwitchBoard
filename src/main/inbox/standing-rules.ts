// Standing always-allow rule engine (FR-009a/009b): per-project rules derived
// from an approved action, evaluated in creation order before an item is
// enqueued; revoked rules stop matching immediately. Only low and medium risk
// requests may create rules; the broker enforces that invariant.
import type { PermissionRule, PermissionRuleMatcher } from '@shared/domain'
import { globToRegExp } from './risk-rules'

const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const

function pathOf(input: Record<string, unknown>): string | null {
  for (const field of PATH_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * Derives the matcher offered to the developer before saving (data-model.md):
 * command prefix for shell commands, a directory glob for file tools, and an
 * exact-input match otherwise.
 */
export function deriveMatcher(toolName: string, input: Record<string, unknown>): PermissionRuleMatcher {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const words = input.command.trim().split(/\s+/)
    return { kind: 'command_prefix', value: words.slice(0, 2).join(' ') }
  }
  const path = pathOf(input)
  if (path) {
    const dir = path.replace(/[/\\][^/\\]*$/, '')
    return { kind: 'path_glob', value: `${dir}${dir.includes('\\') ? '\\' : '/'}**` }
  }
  if (Object.keys(input).length === 0) {
    return { kind: 'tool_only' }
  }
  return { kind: 'exact_input', value: JSON.stringify(input) }
}

export function matchesRule(
  rule: PermissionRule,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (rule.revokedAt !== null) return false
  if (rule.toolName !== toolName) return false
  switch (rule.matcher.kind) {
    case 'tool_only':
      return true
    case 'command_prefix': {
      const command = typeof input.command === 'string' ? input.command.trim() : ''
      const prefix = rule.matcher.value ?? ''
      return prefix.length > 0 && (command === prefix || command.startsWith(`${prefix} `))
    }
    case 'path_glob': {
      const path = pathOf(input)
      if (!path || !rule.matcher.value) return false
      return globToRegExp(rule.matcher.value.replace(/\\/g, '/')).test(path.replace(/\\/g, '/'))
    }
    case 'exact_input':
      return JSON.stringify(input) === rule.matcher.value
  }
}

/** First active match approves (evaluation order is creation order). */
export function evaluateStandingRules(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
): PermissionRule | null {
  for (const rule of rules) {
    if (matchesRule(rule, toolName, input)) return rule
  }
  return null
}
