// T027: standing always-allow rules — matcher derivation, matching semantics,
// revocation, and evaluation order (FR-009a/009b).
import { describe, expect, it } from 'vitest'
import type { PermissionRule } from '@shared/domain'
import { deriveMatcher, evaluateStandingRules, matchesRule } from '@main/inbox/standing-rules'

function makeRule(partial: Partial<PermissionRule>): PermissionRule {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    projectId: 'p1',
    toolName: partial.toolName ?? 'Bash',
    matcher: partial.matcher ?? { kind: 'tool_only' },
    createdFromRequestId: 'r1',
    createdAt: new Date().toISOString(),
    revokedAt: partial.revokedAt ?? null,
  }
}

describe('deriveMatcher', () => {
  it('derives a two-word command prefix for Bash', () => {
    expect(deriveMatcher('Bash', { command: 'git status --short' })).toEqual({
      kind: 'command_prefix',
      value: 'git status',
    })
  })

  it('drops a flag as word two — a flag never widens the base command', () => {
    expect(deriveMatcher('Bash', { command: 'rm -rf dist' })).toEqual({
      kind: 'command_prefix',
      value: 'rm',
    })
    expect(deriveMatcher('Bash', { command: 'ls' })).toEqual({
      kind: 'command_prefix',
      value: 'ls',
    })
  })

  it('derives a directory glob for file tools', () => {
    const matcher = deriveMatcher('Write', { file_path: 'C:\\proj\\src\\a.ts' })
    expect(matcher.kind).toBe('path_glob')
    expect(matcher.value).toContain('C:\\proj\\src')
  })

  it('falls back to tool_only for empty input and exact_input otherwise', () => {
    expect(deriveMatcher('SomeTool', {}).kind).toBe('tool_only')
    expect(deriveMatcher('SomeTool', { q: 1 }).kind).toBe('exact_input')
  })
})

describe('matchesRule', () => {
  it('matches command prefixes on word boundaries only', () => {
    const rule = makeRule({ matcher: { kind: 'command_prefix', value: 'git status' } })
    expect(matchesRule(rule, 'Bash', { command: 'git status' })).toBe(true)
    expect(matchesRule(rule, 'Bash', { command: 'git status --short' })).toBe(true)
    expect(matchesRule(rule, 'Bash', { command: 'git statusx' })).toBe(false)
    expect(matchesRule(rule, 'Bash', { command: 'git push' })).toBe(false)
  })

  it('matches path globs across separator styles', () => {
    const rule = makeRule({
      toolName: 'Write',
      matcher: { kind: 'path_glob', value: 'C:/proj/src/**' },
    })
    expect(matchesRule(rule, 'Write', { file_path: 'C:\\proj\\src\\deep\\a.ts' })).toBe(true)
    expect(matchesRule(rule, 'Write', { file_path: 'C:\\other\\a.ts' })).toBe(false)
  })

  it('rejects directory-traversal that resolves outside the glob base', () => {
    const rule = makeRule({ toolName: 'Read', matcher: { kind: 'path_glob', value: 'C:\\proj\\**' } })
    // Resolves to C:\Users\victim\.ssh\id_rsa — outside C:\proj — must NOT match.
    expect(
      matchesRule(rule, 'Read', { file_path: 'C:\\proj\\..\\..\\Users\\victim\\.ssh\\id_rsa' }),
    ).toBe(false)
    // A legitimate nested path still matches.
    expect(matchesRule(rule, 'Read', { file_path: 'C:\\proj\\src\\a.ts' })).toBe(true)
    // A sibling folder with a shared prefix must not match (prefix confusion).
    expect(matchesRule(rule, 'Read', { file_path: 'C:\\proj-evil\\secret' })).toBe(false)
  })

  it('requires the same tool', () => {
    const rule = makeRule({ toolName: 'Read', matcher: { kind: 'tool_only' } })
    expect(matchesRule(rule, 'Write', {})).toBe(false)
    expect(matchesRule(rule, 'Read', {})).toBe(true)
  })

  it('never matches once revoked (immediate effect)', () => {
    const rule = makeRule({ revokedAt: new Date().toISOString() })
    expect(matchesRule(rule, 'Bash', { command: 'anything' })).toBe(false)
  })
})

describe('evaluateStandingRules', () => {
  it('returns the first matching rule in creation order', () => {
    const first = makeRule({ id: 'a', matcher: { kind: 'command_prefix', value: 'git' } })
    const second = makeRule({ id: 'b', matcher: { kind: 'tool_only' } })
    const match = evaluateStandingRules([first, second], 'Bash', { command: 'git log' })
    expect(match?.id).toBe('a')
  })

  it('returns null when nothing matches', () => {
    expect(evaluateStandingRules([], 'Bash', { command: 'x' })).toBeNull()
  })
})
