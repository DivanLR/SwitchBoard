import { afterEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'

vi.setConfig({ testTimeout: 20_000 })
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  createWorktree,
  currentBranch,
  listWorktrees,
  remoteHost,
  removeWorktree,
  resolvesToCommit,
  slugify,
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
    const tree = await createWorktree({ repoRoot: root, root: join(root, '.worktrees'), title: 'Checkout v2', base: 'main' })
    expect(tree.branch).toBe('feature/checkout-v2')
    expect(tree.path).toBe(resolve(worktreePathFor(join(root, '.worktrees'), 'feature/checkout-v2')))
  })

  it('picks a branch free in every repository of a run, then makes the same one in the others', async () => {
    const fe = repo()
    const api = repo()
    execSync('git branch feature/checkout-v2', { cwd: api, stdio: 'ignore' })
    const apiRoot = join(api, '.worktrees')
    const tree = await createWorktree({
      repoRoot: fe,
      root: join(fe, '.worktrees'),
      title: 'Checkout v2',
      base: 'main',
      others: [{ repoRoot: api, root: apiRoot }],
    })
    expect(tree.branch).toBe('feature/checkout-v2-2')
    const companion = await createWorktree({ repoRoot: api, root: apiRoot, title: 'Checkout v2', base: 'main', branch: tree.branch! })
    expect(companion.branch).toBe('feature/checkout-v2-2')
    expect(companion.path).toBe(resolve(worktreePathFor(apiRoot, 'feature/checkout-v2-2')))
  })

  it('dedupes with -2, -3 when the branch already exists locally or only on a remote', async () => {
    const root = repo()
    execSync('git branch feature/checkout-v2', { cwd: root, stdio: 'ignore' })
    execSync('git update-ref refs/remotes/origin/feature/checkout-v2-2 HEAD', { cwd: root, stdio: 'ignore' })
    const tree = await createWorktree({ repoRoot: root, root: join(root, '.worktrees'), title: 'Checkout v2', base: 'main' })
    expect(tree.branch).toBe('feature/checkout-v2-3')
  })

  it('gives two overlapping starts of the same title their own branch and folder', async () => {
    const root = repo()
    const wtRoot = join(root, '.worktrees')
    const [a, b] = await Promise.all([
      createWorktree({ repoRoot: root, root: wtRoot, title: 'Checkout v2', base: 'main' }),
      createWorktree({ repoRoot: root, root: wtRoot, title: 'Checkout v2', base: 'main' }),
    ])
    expect(new Set([a.branch, b.branch])).toEqual(new Set(['feature/checkout-v2', 'feature/checkout-v2-2']))
    expect(a.path).not.toBe(b.path)
  })

  it('never reuses a folder that already exists for a new run', async () => {
    const root = repo()
    const wtRoot = join(root, '.worktrees')
    mkdirSync(worktreePathFor(wtRoot, 'feature/checkout-v2'), { recursive: true })
    const tree = await createWorktree({ repoRoot: root, root: wtRoot, title: 'Checkout v2', base: 'main' })
    expect(tree.branch).toBe('feature/checkout-v2-2')
  })

  it('reads a base starting with a dash as a ref, never as an option', async () => {
    const root = repo()
    await expect(
      createWorktree({ repoRoot: root, root: join(root, '.worktrees'), title: 'Dash', base: '--no-checkout' }),
    ).rejects.toThrow()
    expect(await resolvesToCommit(root, '--no-checkout')).toBe(false)
    expect(await resolvesToCommit(root, 'main')).toBe(true)
    expect(await resolvesToCommit(root, 'no-such-branch')).toBe(false)
  })

  it('reads the host of an https, ssh or scp-style remote', () => {
    expect(remoteHost('https://github.com/o/r.git\n')).toBe('github.com')
    expect(remoteHost('https://org@dev.azure.com/org/p/_git/r')).toBe('dev.azure.com')
    expect(remoteHost('ssh://git@ssh.dev.azure.com/v3/org/p/r')).toBe('ssh.dev.azure.com')
    expect(remoteHost('git@GitHub.com:o/r.git')).toBe('github.com')
    expect(remoteHost('C:\\repos\\local')).toBeNull()
  })

  it('reports no branch for a detached checkout', async () => {
    const root = repo()
    expect(await currentBranch(root)).toBe('main')
    execSync('git checkout --detach', { cwd: root, stdio: 'ignore' })
    expect(await currentBranch(root)).toBeNull()
  })
})

describe('creating a worktree', () => {
  it('creates it, lists it, and excludes the folder from git when the root is inside the repo', async () => {
    const root = repo()
    const wtRoot = join(root, '.worktrees')

    const tree = await createWorktree({ repoRoot: root, root: wtRoot, title: 'First item', base: 'main' })
    const branch = 'feature/first-item'
    const path = tree.path

    expect(tree.branch).toBe(branch)
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('/.worktrees/')
    expect(existsSync(join(root, '.gitignore'))).toBe(false)

    const listed = await listWorktrees(root)
    expect(listed.map((t) => t.branch)).toContain(branch)
  })

  it('leaves the main checkout clean when the worktree root is a sibling folder', async () => {
    const root = repo()
    const wtRoot = worktreeRoot(root)
    dirs.push(wtRoot)
    await createWorktree({ repoRoot: root, root: wtRoot, title: 'Second item', base: 'main' })

    expect(basename(wtRoot)).toBe(`${basename(root)}.worktrees`)
    expect(dirname(wtRoot)).toBe(dirname(root))
    const status = execSync('git status --porcelain=v1', { cwd: root, encoding: 'utf8' })
    expect(status.trim()).toBe('')
  })
})

function make(root: string, title: string): ReturnType<typeof createWorktree> {
  return createWorktree({ repoRoot: root, root: join(root, '.worktrees'), title, base: 'main' })
}

describe('removing a worktree', () => {
  it('removes a clean one', async () => {
    const root = repo()
    const { path, branch } = await make(root, 'Clean item')

    const outcome = await removeWorktree(root, path)

    expect(outcome).toEqual({ removed: true, dirty: [] })
    expect(existsSync(path)).toBe(false)
    expect((await listWorktrees(root)).map((t) => t.branch)).not.toContain(branch)
  })

  it('refuses a dirty one and says what is uncommitted, rather than discarding it', async () => {
    const root = repo()
    const { path } = await make(root, 'Dirty item')
    writeFileSync(join(path, 'work-in-progress.txt'), 'unsaved\n')

    const outcome = await removeWorktree(root, path)

    expect(outcome.removed).toBe(false)
    expect(outcome.dirty).toEqual(['?? work-in-progress.txt'])
    expect(existsSync(join(path, 'work-in-progress.txt'))).toBe(true)
  })

  it('deletes the branch too when asked, so a rolled back run leaves no branch behind', async () => {
    const root = repo()
    const { path, branch } = await make(root, 'Rolled back')

    await removeWorktree(root, path, { force: true, deleteBranch: branch! })

    expect(execSync('git branch --list', { cwd: root, encoding: 'utf8' })).not.toContain('rolled-back')
  })

  it('discards a dirty one only when forced', async () => {
    const root = repo()
    const { path } = await make(root, 'Forced item')
    writeFileSync(join(path, 'scratch.txt'), 'x\n')

    expect((await removeWorktree(root, path, { force: true })).removed).toBe(true)
    expect(existsSync(path)).toBe(false)
  })
})

describe('worktree dirtiness', () => {
  it('reports untracked files and keeps two worktrees apart', async () => {
    const root = repo()
    const pathA = (await make(root, 'Item A')).path
    const pathB = (await make(root, 'Item B')).path
    writeFileSync(join(pathA, 'only-in-a.txt'), 'a\n')

    expect(existsSync(join(pathB, 'only-in-a.txt'))).toBe(false)
    expect(await worktreeDirty(pathA)).toEqual(['?? only-in-a.txt'])
    expect(await worktreeDirty(pathB)).toEqual([])
  })
})
