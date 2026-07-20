// Standing always-allow rule engine (FR-009a/009b): per-project rules derived
// from an approved action, evaluated in creation order before an item is
// enqueued; revoked rules stop matching immediately. Only low and medium risk
// requests may create rules; the broker enforces that invariant.
import { isAbsolute, resolve, sep } from 'node:path'
import type { PermissionRule, PermissionRuleMatcher } from '@shared/domain'
import { globToRegExp } from './risk-rules'

const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const

/** The literal directory prefix of a glob (everything before the first wildcard). */
function globBaseDir(glob: string): string {
  const wild = glob.search(/[*?]/)
  const prefix = wild === -1 ? glob : glob.slice(0, wild)
  const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'))
  return cut === -1 ? prefix : prefix.slice(0, cut)
}

/**
 * True when `candidate` matches the glob AND its RESOLVED path stays inside the
 * glob's base directory. Resolving first collapses `.`/`..`, so a path like
 * `C:\proj\..\..\secret` can no longer match a `C:\proj\**` rule by string
 * coincidence (directory-traversal bypass).
 */
function withinGlob(glob: string, candidate: string): boolean {
  const base = globBaseDir(glob)
  if (!base) return false
  const resolvedBase = resolve(base).replace(/[/\\]+$/, '')
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedBase, candidate)
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(resolvedBase + sep)) {
    return false
  }
  return globToRegExp(glob.replace(/\\/g, '/')).test(resolvedCandidate.replace(/\\/g, '/'))
}

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
    // Flag-aware two-token base (design reference): "git commit -m x" → "git
    // commit", but "rm -rf dist" → "rm" — a flag as word 2 never widens a rule.
    const words = input.command.trim().split(/\s+/)
    const value = words[1] && !words[1].startsWith('-') ? `${words[0]} ${words[1]}` : words[0]
    return { kind: 'command_prefix', value }
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
      return withinGlob(rule.matcher.value, path)
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
