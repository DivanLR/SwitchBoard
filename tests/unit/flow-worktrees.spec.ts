import { afterEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'

vi.setConfig({ testTimeout: 20_000 })
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  slugify,
  sweepOrphanWorktrees,
  uniqueBranchName,
  worktreeDirty,
  worktreePathFor,
  worktreeRoot,
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
  it('slugifies a title, capped at 40 characters', () => {
    expect(slugify('Fix the cart race condition once and for all, properly')).toBe(
      'fix-the-cart-race-condition-once-and-for',
    )
    expect(slugify('!!!')).toBe('feature')
  })

  it('defaults the worktree root to a sibling of the repo, named <repo>.worktrees', () => {
    expect(worktreeRoot('C:\\work\\alpha')).toBe(join('C:\\work', 'alpha.worktrees'))
    expect(worktreeRoot('C:\\work\\alpha', 'C:\\short')).toBe(resolve('C:\\short'))
  })

  it('derives a directory name from the branch without the feature prefix', () => {
    expect(worktreePathFor('C:\\root', 'feature/cart-race')).toBe(join('C:\\root', 'cart-race'))
  })

  it('picks the plain slug when the branch is free', async () => {
    const root = repo()
    expect(await uniqueBranchName(root, 'Checkout v2')).toBe('feature/checkout-v2')
  })

  it('dedupes with -2, -3 when the branch already exists', async () => {
    const root = repo()
    execSync('git branch feature/checkout-v2', { cwd: root, stdio: 'ignore' })
    execSync('git branch feature/checkout-v2-2', { cwd: root, stdio: 'ignore' })
    expect(await uniqueBranchName(root, 'Checkout v2')).toBe('feature/checkout-v2-3')
  })
})

describe('creating a worktree', () => {
  it('creates it, lists it, and excludes the folder from git when the root is inside the repo', async () => {
    const root = repo()
    const branch = 'feature/first-item'
    const wtRoot = join(root, '.worktrees')
    const path = worktreePathFor(wtRoot, branch)

    const tree = await createWorktree({ repoRoot: root, path, branch, base: 'main' })

    expect(tree.branch).toBe(branch)
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('/.worktrees/')
    expect(existsSync(join(root, '.gitignore'))).toBe(false)

    const listed = await listWorktrees(root)
    expect(listed.map((t) => t.branch)).toContain(branch)
  })

  it('leaves the main checkout clean when the worktree root is a sibling folder', async () => {
    const root = repo()
    const branch = 'feature/second-item'
    const wtRoot = worktreeRoot(root)
    dirs.push(wtRoot)
    await createWorktree({
      repoRoot: root,
      path: worktreePathFor(wtRoot, branch),
      branch,
      base: 'main',
    })

    expect(basename(wtRoot)).toBe(`${basename(root)}.worktrees`)
    expect(dirname(wtRoot)).toBe(dirname(root))
    const status = execSync('git status --porcelain=v1', { cwd: root, encoding: 'utf8' })
    expect(status.trim()).toBe('')
  })

  it('is idempotent: asking twice returns the worktree that is already there', async () => {
    const root = repo()
    const branch = 'feature/third-item'
    const path = worktreePathFor(join(root, '.worktrees'), branch)

    const first = await createWorktree({ repoRoot: root, path, branch, base: 'main' })
    const second = await createWorktree({ repoRoot: root, path, branch, base: 'main' })

    expect(second.path).toBe(first.path)
    expect((await listWorktrees(root)).filter((t) => t.branch === branch)).toHaveLength(1)
  })

  it('refuses a branch that another worktree already holds', async () => {
    const root = repo()
    const branch = 'feature/fourth-item'
    const wtRoot = join(root, '.worktrees')
    await createWorktree({
      repoRoot: root,
      path: worktreePathFor(wtRoot, branch),
      branch,
      base: 'main',
    })

    await expect(
      createWorktree({
        repoRoot: root,
        path: join(wtRoot, 'somewhere-else'),
        branch,
        base: 'main',
      }),
    ).rejects.toThrow(/already checked out/)
  })
})

describe('removing a worktree', () => {
  it('removes a clean one', async () => {
    const root = repo()
    const branch = 'feature/clean-item'
    const path = worktreePathFor(join(root, '.worktrees'), branch)
    await createWorktree({ repoRoot: root, path, branch, base: 'main' })

    const outcome = await removeWorktree(root, path)

    expect(outcome).toEqual({ removed: true, dirty: [] })
    expect(existsSync(path)).toBe(false)
    expect((await listWorktrees(root)).map((t) => t.branch)).not.toContain(branch)
  })

  it('refuses a dirty one and says what is uncommitted, rather than discarding it', async () => {
    const root = repo()
    const branch = 'feature/dirty-item'
    const path = worktreePathFor(join(root, '.worktrees'), branch)
    await createWorktree({ repoRoot: root, path, branch, base: 'main' })
    writeFileSync(join(path, 'work-in-progress.txt'), 'unsaved\n')

    const outcome = await removeWorktree(root, path)

    expect(outcome.removed).toBe(false)
    expect(outcome.dirty).toEqual(['?? work-in-progress.txt'])
    expect(existsSync(join(path, 'work-in-progress.txt'))).toBe(true)
  })

  it('discards a dirty one only when forced', async () => {
    const root = repo()
    const branch = 'feature/forced-item'
    const path = worktreePathFor(join(root, '.worktrees'), branch)
    await createWorktree({ repoRoot: root, path, branch, base: 'main' })
    writeFileSync(join(path, 'scratch.txt'), 'x\n')

    expect((await removeWorktree(root, path, { force: true })).removed).toBe(true)
    expect(existsSync(path)).toBe(false)
  })
})

describe('the startup sweep', () => {
  it('removes the worktrees no run still wants and keeps the rest', async () => {
    const root = repo()
    const wtRoot = join(root, '.worktrees')
    const keepPath = worktreePathFor(wtRoot, 'feature/still-running')
    const gonePath = worktreePathFor(wtRoot, 'feature/finished')
    await createWorktree({ repoRoot: root, path: keepPath, branch: 'feature/still-running', base: 'main' })
    await createWorktree({ repoRoot: root, path: gonePath, branch: 'feature/finished', base: 'main' })

    const swept = await sweepOrphanWorktrees(root, wtRoot, [keepPath])

    expect(swept.removed).toEqual([resolve(gonePath)])
    expect(existsSync(keepPath)).toBe(true)
    expect(existsSync(gonePath)).toBe(false)
  })

  it('never sweeps the main checkout, and never touches a dirty orphan', async () => {
    const root = repo()
    const wtRoot = join(root, '.worktrees')
    const path = worktreePathFor(wtRoot, 'feature/orphan-with-work')
    await createWorktree({ repoRoot: root, path, branch: 'feature/orphan-with-work', base: 'main' })
    writeFileSync(join(path, 'unsaved.txt'), 'keep me\n')

    const swept = await sweepOrphanWorktrees(root, wtRoot, [])

    expect(swept.removed).toEqual([])
    expect(swept.kept).toEqual([resolve(path)])
    expect(existsSync(join(root, 'README.md'))).toBe(true)
    expect(existsSync(join(path, 'unsaved.txt'))).toBe(true)
  })
})

describe('worktree dirtiness', () => {
  it('reports untracked files and keeps two worktrees apart', async () => {
    const root = repo()
    const wtRoot = join(root, '.worktrees')
    const pathA = worktreePathFor(wtRoot, 'feature/item-a')
    const pathB = worktreePathFor(wtRoot, 'feature/item-b')
    await createWorktree({ repoRoot: root, path: pathA, branch: 'feature/item-a', base: 'main' })
    await createWorktree({ repoRoot: root, path: pathB, branch: 'feature/item-b', base: 'main' })
    writeFileSync(join(pathA, 'only-in-a.txt'), 'a\n')

    expect(existsSync(join(pathB, 'only-in-a.txt'))).toBe(false)
    expect(await worktreeDirty(pathA)).toEqual(['?? only-in-a.txt'])
    expect(await worktreeDirty(pathB)).toEqual([])
  })
})
