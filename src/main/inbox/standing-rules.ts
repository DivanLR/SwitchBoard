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
 * True when `candidate`'s RESOLVED path is `dir` itself or nested under it.
 * Resolving first collapses `.`/`..`, closing the directory-traversal bypass.
 * Windows paths are case-insensitive, so compare case-folded there — otherwise a
 * rule (or cwd) whose casing differs from the tool's reported path silently
 * fails to match.
 */
export function isWithinDir(dir: string, candidate: string): boolean {
  const resolvedDir = resolve(dir).replace(/[/\\]+$/, '')
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedDir, candidate)
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  return (
    fold(resolvedCandidate) === fold(resolvedDir) ||
    fold(resolvedCandidate).startsWith(`${fold(resolvedDir)}${sep}`)
  )
}

/**
 * True when `candidate` matches the glob AND its RESOLVED path stays inside the
 * glob's base directory (directory-traversal-safe via isWithinDir).
 */
function withinGlob(glob: string, candidate: string): boolean {
  const base = globBaseDir(glob)
  if (!base || !isWithinDir(base, candidate)) return false
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolve(base), candidate)
  return globToRegExp(glob.replace(/\\/g, '/')).test(resolvedCandidate.replace(/\\/g, '/'))
}

export function pathOf(input: Record<string, unknown>): string | null {
  for (const field of PATH_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** True when the tool input's path field resolves inside `projectPath` — the
 *  cwd-containment auto-approve for in-folder Read/Write/Edit. */
export function isPathWithinProject(
  projectPath: string,
  input: Record<string, unknown>,
): boolean {
  const path = pathOf(input)
  return path !== null && isWithinDir(projectPath, path)
}

/**
 * Derives the always-allow matcher for a decided Bash command (the only tool the
 * broker ever derives a rule from — see permission-broker `alwaysAllow`): a
 * flag-aware two-token prefix, "git commit -m x" → "git commit", but "rm -rf
 * dist" → "rm" (a flag as word 2 never widens a rule). Folder-access rules are
 * seeded with their `path_glob` matcher directly, so no path derivation is
 * needed here.
 */
export function deriveMatcher(command: string): PermissionRuleMatcher {
  const words = command.trim().split(/\s+/)
  const value = words[1] && !words[1].startsWith('-') ? `${words[0]} ${words[1]}` : words[0]
  return { kind: 'command_prefix', value }
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
  return rules.find((rule) => matchesRule(rule, toolName, input)) ?? null
}
