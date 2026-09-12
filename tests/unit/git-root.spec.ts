import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitRoot } from '@main/sessions/wslc-sandbox'

const made: string[] = []

function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-gitroot-'))
  made.push(dir)
  return dir
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('gitRoot', () => {
  it('is the project root when the root is the repository', () => {
    const root = tempTree()
    mkdirSync(join(root, '.git'))
    expect(gitRoot(root)).toBe(root)
  })

  it('finds the repository one level down, the layout that broke the Diff tab', () => {
    const root = tempTree()
    const inner = join(root, 'Ppl.Einstein.External.Api')
    mkdirSync(inner)
    mkdirSync(join(inner, '.git'))
    writeFileSync(join(root, 'README.md'), '#')
    mkdirSync(join(root, 'docs'))

    expect(gitRoot(root)).toBe(inner)
  })

  it('prefers the root over a child, so a repository containing another is not misread', () => {
    const root = tempTree()
    mkdirSync(join(root, '.git'))
    const inner = join(root, 'vendor')
    mkdirSync(inner)
    mkdirSync(join(inner, '.git'))

    expect(gitRoot(root)).toBe(root)
  })

  it('accepts a .git FILE, which is what a worktree or submodule checkout has', () => {
    const root = tempTree()
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x')
    expect(gitRoot(root)).toBe(root)
  })

  it('is null when there is no repository at or just below the root', () => {
    const root = tempTree()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'notes.txt'), 'x')
    expect(gitRoot(root)).toBeNull()
  })

  it('does not go hunting two levels down', () => {
    const root = tempTree()
    const deep = join(root, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    mkdirSync(join(deep, '.git'))
    expect(gitRoot(root)).toBeNull()
  })

  it('returns null rather than throwing for a path that does not exist', () => {
    expect(gitRoot(join(tmpdir(), 'sb-gitroot-does-not-exist-12345'))).toBeNull()
  })
})
