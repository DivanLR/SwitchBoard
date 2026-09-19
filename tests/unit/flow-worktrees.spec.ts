import { afterEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  branchNameFor,
  createWorktree,
  listWorktrees,
  removeWorktree,
  sweepOrphanWorktrees,
  worktreeDirty,
  worktreePathFor,
  worktreeRoot,
  WORKTREE_DIR,
} from '@main/flow/worktrees'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
    }
  }
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-wt-'))
  dirs.push(dir)
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'README.md'), 'one\n')
  execSync('git add README.md && git commit -m one', { cwd: dir, stdio: 'ignore' })
  return dir
}

describe('branch and path naming', () => {
  it('builds a branch from the work item and a short slug', () => {
    expect(branchNameFor('12345', 'Fix the cart race condition')).toBe(
      'flow/12345-fix-the-cart-race-condit',
    )
  })

  it('falls back to the work item alone when the title has nothing usable', () => {
    expect(branchNameFor('99', '!!!')).toBe('flow/99')
  })

  it('keeps worktrees inside the project by default, and honours an override', () => {
    expect(worktreeRoot('C:\\work\\alpha')).toBe(join('C:\\work\\alpha', WORKTREE_DIR))
    expect(worktreeRoot('C:\\work\\alpha', 'C:\\short')).toBe(resolve('C:\\short'))
  })

  it('derives a directory name from the branch without the flow prefix', () => {
    expect(worktreePathFor('C:\\root', 'flow/12345-cart')).toBe(join('C:\\root', '12345-cart'))
  })
})

describe('creating a worktree', () => {
  it('creates it, lists it, and excludes the folder from git without touching .gitignore', async () => {
    const root = repo()
    const branch = branchNameFor('1', 'first item')
    const path = worktreePathFor(worktreeRoot(root), branch)

    const tree = await createWorktree({ repoRoot: root, path, branch, base: 'main' })

    expect(tree.branch).toBe(branch)
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain(`/${WORKTREE_DIR}/`)
    expect(existsSync(join(root, '.gitignore'))).toBe(false)

    const listed = await listWorktrees(root)
    expect(listed.map((t) => t.branch)).toContain(branch)
  })

  it('leaves the main checkout clean, so the Diff tab does not fill with the worktree', async () => {
    const root = repo()
    const branch = branchNameFor('2', 'second item')
    await createWorktree({
      repoRoot: root,
      path: worktreePathFor(worktreeRoot(root), branch),
      branch,
      base: 'main',
    })

    const status = execSync('git status --porcelain=v1', { cwd: root, encoding: 'utf8' })
    expect(status.trim()).toBe('')
  })

  it('is idempotent: asking twice returns the worktree that is already there', async () => {
    const root = repo()
    const branch = branchNameFor('3', 'third item')
    const path = worktreePathFor(worktreeRoot(root), branch)

    const first = await createWorktree({ repoRoot: root, path, branch, base: 'main' })
    const second = await createWorktree({ repoRoot: root, path, branch, base: 'main' })

    expect(second.path).toBe(first.path)
    expect((await listWorktrees(root)).filter((t) => t.branch === branch)).toHaveLength(1)
  })

  it('refuses a branch that another worktree already holds', async () => {
    const root = repo()
    const branch = branchNameFor('4', 'fourth item')
    await createWorktree({
      repoRoot: root,
      path: worktreePathFor(worktreeRoot(root), branch),
      branch,
      base: 'main',
    })

    await expect(
      createWorktree({
        repoRoot: root,
        path: join(worktreeRoot(root), 'somewhere-else'),
        branch,
        base: 'main',
      }),
    ).rejects.toThrow(/already checked out/)
  })

  it('keeps two worktrees of one repo apart', async () => {
    const root = repo()
    const a = branchNameFor('5', 'item a')
    const b = branchNameFor('6', 'item b')
    const pathA = worktreePathFor(worktreeRoot(root), a)
    const pathB = worktreePathFor(worktreeRoot(root), b)

    await createWorktree({ repoRoot: root, path: pathA, branch: a, base: 'main' })
    await createWorktree({ repoRoot: root, path: pathB, branch: b, base: 'main' })
    writeFileSync(join(pathA, 'only-in-a.txt'), 'a\n')

    expect(existsSync(join(pathB, 'only-in-a.txt'))).toBe(false)
    expect(await worktreeDirty(pathA)).toEqual(['?? only-in-a.txt'])
    expect(await worktreeDirty(pathB)).toEqual([])
  })
})

describe('removing a worktree', () => {
  it('removes a clean one', async () => {
    const root = repo()
    const branch = branchNameFor('7', 'clean item')
    const path = worktreePathFor(worktreeRoot(root), branch)
    await createWorktree({ repoRoot: root, path, branch, base: 'main' })

    const outcome = await removeWorktree(root, path)

    expect(outcome).toEqual({ removed: true, dirty: [] })
    expect(existsSync(path)).toBe(false)
    expect((await listWorktrees(root)).map((t) => t.branch)).not.toContain(branch)
  })

  it('refuses a dirty one and says what is uncommitted, rather than discarding it', async () => {
    const root = repo()
    const branch = branchNameFor('8', 'dirty item')
    const path = worktreePathFor(worktreeRoot(root), branch)
    await createWorktree({ repoRoot: root, path, branch, base: 'main' })
    writeFileSync(join(path, 'work-in-progress.txt'), 'unsaved\n')

    const outcome = await removeWorktree(root, path)

    expect(outcome.removed).toBe(false)
    expect(outcome.dirty).toEqual(['?? work-in-progress.txt'])
    expect(existsSync(join(path, 'work-in-progress.txt'))).toBe(true)
  })

  it('discards a dirty one only when forced', async () => {
    const root = repo()
    const branch = branchNameFor('9', 'forced item')
    const path = worktreePathFor(worktreeRoot(root), branch)
    await createWorktree({ repoRoot: root, path, branch, base: 'main' })
    writeFileSync(join(path, 'scratch.txt'), 'x\n')

    expect((await removeWorktree(root, path, { force: true })).removed).toBe(true)
    expect(existsSync(path)).toBe(false)
  })
})

describe('the startup sweep', () => {
  it('removes the worktrees no run still wants and keeps the rest', async () => {
    const root = repo()
    const keepBranch = branchNameFor('10', 'still running')
    const goneBranch = branchNameFor('11', 'finished')
    const keepPath = worktreePathFor(worktreeRoot(root), keepBranch)
    const gonePath = worktreePathFor(worktreeRoot(root), goneBranch)
    await createWorktree({ repoRoot: root, path: keepPath, branch: keepBranch, base: 'main' })
    await createWorktree({ repoRoot: root, path: gonePath, branch: goneBranch, base: 'main' })

    const swept = await sweepOrphanWorktrees(root, worktreeRoot(root), [keepPath])

    expect(swept.removed).toEqual([resolve(gonePath)])
    expect(existsSync(keepPath)).toBe(true)
    expect(existsSync(gonePath)).toBe(false)
  })

  it('never sweeps the main checkout, and never touches a dirty orphan', async () => {
    const root = repo()
    const branch = branchNameFor('12', 'orphan with work')
    const path = worktreePathFor(worktreeRoot(root), branch)
    await createWorktree({ repoRoot: root, path, branch, base: 'main' })
    writeFileSync(join(path, 'unsaved.txt'), 'keep me\n')

    const swept = await sweepOrphanWorktrees(root, worktreeRoot(root), [])

    expect(swept.removed).toEqual([])
    expect(swept.kept).toEqual([resolve(path)])
    expect(existsSync(join(root, 'README.md'))).toBe(true)
    expect(existsSync(join(path, 'unsaved.txt'))).toBe(true)
  })
})
