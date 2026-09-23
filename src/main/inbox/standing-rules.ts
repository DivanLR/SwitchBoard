import { isAbsolute, basename, dirname, posix, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import type { PermissionRule, PermissionRuleMatcher } from '@shared/domain'

const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const

const CHAINS_ANOTHER_COMMAND = /&&|\|\||[;|`\n\r]|\$\(/

function globBaseDir(glob: string): string {
  const wild = glob.search(/[*?]/)
  const prefix = wild === -1 ? glob : glob.slice(0, wild)
  const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'))
  return cut === -1 ? prefix : prefix.slice(0, cut)
}

function realpathOrNearestAncestor(lexicalPath: string): string | null {
  let probe = lexicalPath
  let remainder = ''
  for (;;) {
    try {
      const real = realpathSync.native(probe)
      if (!remainder) return real
      return real.endsWith(sep) ? `${real}${remainder}` : `${real}${sep}${remainder}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null 
      const parent = dirname(probe)
      if (parent === probe) return null 
      remainder = remainder ? `${basename(probe)}${sep}${remainder}` : basename(probe)
      probe = parent
    }
  }
}

function isWithinDir(dir: string, candidate: string): boolean {
  const resolvedDir = resolve(dir).replace(/[/\\]+$/, '')
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedDir, candidate)
  const realDir = realpathOrNearestAncestor(resolvedDir)
  const realCandidate = realpathOrNearestAncestor(resolvedCandidate)
  if (realDir === null || realCandidate === null) return false
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  return (
    fold(realCandidate) === fold(realDir) ||
    fold(realCandidate).startsWith(`${fold(realDir)}${sep}`)
  )
}

const foldPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

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

export function isPathWithinProject(
  projectPath: string,
  input: Record<string, unknown>,
  cwd = projectPath,
): boolean {
  const path = pathOf(input)
  return path !== null && isWithinDir(projectPath, resolve(cwd, path))
}

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
      return !CHAINS_ANOTHER_COMMAND.test(command.slice(prefix.length))
    }
    case 'path_glob': {
      const path = pathOf(input)
      if (!path || !rule.matcher.value) return false
      return withinGlob(rule.matcher.value, path)
    }
  }
}

export function evaluateStandingRules(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
): PermissionRule | null {
  return rules.find((rule) => matchesRule(rule, toolName, input)) ?? null
}
