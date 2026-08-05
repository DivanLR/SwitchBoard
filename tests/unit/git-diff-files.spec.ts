// Diff tab (specs/003-diff-tab): readDiffList / readFileDiff against a real
// git working tree — the porcelain/numstat/untracked-file-read combination
// research.md decided on, not a mocked git.
import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDiffList, readFileDiff } from '@main/sessions/session-manager'

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-tab-'))
  execSync('git init', { cwd: dir, stdio: 'ignore' })
  execSync('git -c user.email=test@test.com -c user.name=test commit --allow-empty -m init', {
    cwd: dir,
    stdio: 'ignore',
  })
  return dir
}

describe('readDiffList', () => {
  it('lists a tracked modification with its line counts', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\n')
      execSync('git add a.txt', { cwd: dir })
      execSync('git -c user.email=test@test.com -c user.name=test commit -m add', { cwd: dir })
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')

      const result = await readDiffList(dir)
      expect(result.gitNotice).toBeNull()
      expect(result.files).toEqual([
        { path: 'a.txt', status: 'modified', addedLines: 1, removedLines: 0, binary: false },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('includes a new untracked file alongside tracked changes', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'new.txt'), 'hello\nworld\n')

      const result = await readDiffList(dir)
      expect(result.gitNotice).toBeNull()
      expect(result.files).toEqual([
        { path: 'new.txt', status: 'untracked', addedLines: 2, removedLines: 0, binary: false },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a binary untracked file as counts-unavailable rather than 0/0', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]))

      const result = await readDiffList(dir)
      expect(result.files).toEqual([
        { path: 'blob.bin', status: 'untracked', addedLines: null, removedLines: null, binary: true },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('states the limitation, not an empty list, when there is no repository at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-tab-norepo-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'content')
      const result = await readDiffList(dir)
      expect(result.gitNotice).not.toBeNull()
      expect(result.files).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readFileDiff', () => {
  it('returns added/removed lines for a tracked modification', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
      execSync('git add a.txt', { cwd: dir })
      execSync('git -c user.email=test@test.com -c user.name=test commit -m add', { cwd: dir })
      writeFileSync(join(dir, 'a.txt'), 'one\nthree\n')

      const diff = await readFileDiff(dir, 'a.txt')
      expect(diff?.binary).toBe(false)
      expect(diff?.lines).toEqual(
        expect.arrayContaining([
          { type: 'del', text: 'two' },
          { type: 'add', text: 'three' },
        ]),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('presents a new untracked file entirely as additions', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'new.txt'), 'hello\nworld\n')

      const diff = await readFileDiff(dir, 'new.txt')
      expect(diff).toEqual({
        binary: false,
        lines: [
          { type: 'add', text: 'hello' },
          { type: 'add', text: 'world' },
        ],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a path with no current change', async () => {
    const dir = initRepo()
    try {
      writeFileSync(join(dir, 'clean.txt'), 'unchanged\n')
      execSync('git add clean.txt', { cwd: dir })
      execSync('git -c user.email=test@test.com -c user.name=test commit -m add', { cwd: dir })

      const diff = await readFileDiff(dir, 'clean.txt')
      expect(diff).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
