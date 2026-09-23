import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { artefactRelPath, defaultArtefactKind, resolveArtefactPath } from '@main/flow/artefacts'

describe('artefact path containment', () => {
  it('resolves a plain relative path inside the worktree', () => {
    const resolved = resolveArtefactPath(
      'C:\\work\\alpha.worktrees\\checkout',
      'specs/001-x/spec.md',
    )
    expect(resolved).toBe(resolve('C:\\work\\alpha.worktrees\\checkout', 'specs/001-x/spec.md'))
  })

  it('refuses a path that climbs out of the worktree', () => {
    expect(
      resolveArtefactPath('C:\\work\\alpha.worktrees\\checkout', '../../../etc/passwd'),
    ).toBeNull()
    expect(
      resolveArtefactPath('C:\\work\\alpha.worktrees\\checkout', '..\\..\\secrets.txt'),
    ).toBeNull()
  })

  it('refuses an absolute path that names somewhere else entirely', () => {
    expect(
      resolveArtefactPath('C:\\work\\alpha.worktrees\\checkout', 'C:\\Windows\\System32'),
    ).toBeNull()
  })

  it('allows the worktree root itself', () => {
    expect(resolveArtefactPath('C:\\work\\alpha.worktrees\\checkout', '.')).toBe(
      resolve('C:\\work\\alpha.worktrees\\checkout'),
    )
  })
})

describe('artefact relative paths', () => {
  it('maps each kind to its file under the spec folder', () => {
    expect(artefactRelPath('specs/001-x', 'spec')).toBe(join('specs/001-x', 'spec.md'))
    expect(artefactRelPath('specs/001-x', 'plan')).toBe(join('specs/001-x', 'plan.md'))
    expect(artefactRelPath('specs/001-x', 'tasks')).toBe(join('specs/001-x', 'tasks.md'))
    expect(artefactRelPath('specs/001-x', 'postman')).toBe(join('specs/001-x', 'postman'))
  })

  it('has no file for the test report, which lives in the database, or without a spec folder yet', () => {
    expect(artefactRelPath('specs/001-x', 'report')).toBeNull()
    expect(artefactRelPath(null, 'spec')).toBeNull()
  })
})

describe('default artefact kind per stage', () => {
  it('picks spec.md for the spec stage', () => {
    expect(defaultArtefactKind('spec')).toBe('spec')
  })

  it('picks the task checklist for plan and build', () => {
    expect(defaultArtefactKind('plan')).toBe('tasks')
    expect(defaultArtefactKind('build')).toBe('tasks')
  })

  it('picks the stored report for test', () => {
    expect(defaultArtefactKind('test')).toBe('report')
  })
})
