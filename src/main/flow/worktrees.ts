import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const execFileAsync = promisify(execFile)
const GIT_OPTS = { timeout: 30_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as const

export const WORKTREE_DIR = '.worktrees'

const EXCLUDE_LINE = `/${WORKTREE_DIR}/`
const SLUG_MAX = 24

export interface Worktree {
  path: string
  branch: string | null
  head: string
  locked: boolean
  prunable: boolean
}

export function worktreeRoot(projectPath: string, override?: string | null): string {
  const root = override?.trim()
  return root ? resolve(root) : join(projectPath, WORKTREE_DIR)
}

export function branchNameFor(workItemId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  return slug ? `flow/${workItemId}-${slug}` : `flow/${workItemId}`
}

export function worktreePathFor(root: string, branch: string): string {
  return join(root, branch.replace(/^flow\//, '').toLowerCase())
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], GIT_OPTS)
  return stdout
}

export async function currentBranch(repoRoot: string): Promise<string> {
  const name = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  return name === 'HEAD' || name.length === 0 ? 'HEAD' : name
}

export async function ensureWorktreeIgnore(repoRoot: string): Promise<void> {
  const gitDir = (await git(repoRoot, ['rev-parse', '--git-common-dir'])).trim()
  const excludePath = resolve(repoRoot, gitDir, 'info', 'exclude')
  let current = ''
  try {
    current = await readFile(excludePath, 'utf8')
  } catch {
    await mkdir(resolve(excludePath, '..'), { recursive: true })
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_LINE)) return
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  await appendFile(excludePath, `${prefix}${EXCLUDE_LINE}\n`, 'utf8')
}

export async function listWorktrees(repoRoot: string): Promise<Worktree[]> {
  const stdout = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  const trees: Worktree[] = []
  let current: Partial<Worktree> | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) {
      if (current?.path) trees.push({ locked: false, prunable: false, head: '', branch: null, ...current } as Worktree)
      current = null
      continue
    }
    if (line.startsWith('worktree ')) current = { path: resolve(line.slice(9)), branch: null, head: '', locked: false, prunable: false }
    else if (!current) continue
    else if (line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'detached') current.branch = null
    else if (line.startsWith('locked')) current.locked = true
    else if (line.startsWith('prunable')) current.prunable = true
  }
  if (current?.path) trees.push({ locked: false, prunable: false, head: '', branch: null, ...current } as Worktree)
  return trees
}

export async function worktreeDirty(path: string): Promise<string[]> {
  const stdout = await git(path, ['status', '--porcelain=v1'])
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
}

let chain: Promise<unknown> = Promise.resolve()

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work)
  chain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export async function createWorktree(input: {
  repoRoot: string
  path: string
  branch: string
  base: string
}): Promise<Worktree> {
  return serialise(async () => {
    const existing = await listWorktrees(input.repoRoot)
    const taken = existing.find(
      (tree) => tree.path.toLowerCase() === resolve(input.path).toLowerCase(),
    )
    if (taken) return taken
    if (existing.some((tree) => tree.branch === input.branch)) {
      throw new Error(`The branch ${input.branch} is already checked out in another worktree.`)
    }
    await ensureWorktreeIgnore(input.repoRoot)
    await mkdir(resolve(input.path, '..'), { recursive: true })
    await git(input.repoRoot, ['worktree', 'add', '-b', input.branch, input.path, input.base])
    await git(input.path, ['config', 'core.longpaths', 'true']).catch(() => '')
    const made = (await listWorktrees(input.repoRoot)).find(
      (tree) => tree.path.toLowerCase() === resolve(input.path).toLowerCase(),
    )
    if (!made) throw new Error(`git reported no worktree at ${input.path} after creating it.`)
    return made
  })
}

export async function removeWorktree(
  repoRoot: string,
  path: string,
  opts?: { force?: boolean },
): Promise<{ removed: boolean; dirty: string[] }> {
  return serialise(async () => {
    if (!existsSync(path)) {
      await git(repoRoot, ['worktree', 'prune']).catch(() => '')
      return { removed: true, dirty: [] }
    }
    const dirty = opts?.force === true ? [] : await worktreeDirty(path).catch(() => [])
    if (dirty.length > 0) return { removed: false, dirty }
    const args = ['worktree', 'remove', ...(opts?.force === true ? ['--force'] : []), path]
    try {
      await git(repoRoot, args)
    } catch {
      await delay(500)
      await git(repoRoot, args)
    }
    await git(repoRoot, ['worktree', 'prune']).catch(() => '')
    return { removed: true, dirty: [] }
  })
}

export async function sweepOrphanWorktrees(
  repoRoot: string,
  root: string,
  keep: readonly string[],
): Promise<{ removed: string[]; kept: string[] }> {
  const wanted = new Set(keep.map((path) => resolve(path).toLowerCase()))
  const under = resolve(root).toLowerCase()
  const removed: string[] = []
  const kept: string[] = []
  for (const tree of await listWorktrees(repoRoot)) {
    const path = tree.path.toLowerCase()
    if (!path.startsWith(under) || path === under) continue
    if (wanted.has(path)) continue
    const outcome = await removeWorktree(repoRoot, tree.path).catch(() => ({ removed: false, dirty: ['unknown'] }))
    if (outcome.removed) removed.push(tree.path)
    else kept.push(tree.path)
  }
  return { removed, kept }
}
