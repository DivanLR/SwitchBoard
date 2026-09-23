import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const execFileAsync = promisify(execFile)
const GIT_OPTS = { timeout: 30_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as const

const SLUG_MAX = 40

export interface Worktree {
  path: string
  branch: string | null
  head: string
  locked: boolean
  prunable: boolean
}

export function worktreeRoot(projectPath: string, override?: string | null): string {
  const root = override?.trim()
  if (root) return resolve(root)
  const abs = resolve(projectPath)
  return join(dirname(abs), `${basename(abs)}.worktrees`)
}

export function slugify(title: string, max = SLUG_MAX): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'feature'
}

export function worktreePathFor(root: string, branch: string): string {
  return join(root, branch.replace(/^feature\//, '').toLowerCase())
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], GIT_OPTS)
  return stdout
}

export async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    const name = (await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    return name.length === 0 ? null : name
  } catch (e) {
    if ((e as { code?: unknown }).code === 1) return null
    throw e
  }
}

export async function resolvesToCommit(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

export function remoteHost(remote: string): string | null {
  const url = remote.trim()
  if (URL.canParse(url)) return new URL(url).hostname.toLowerCase() || null
  return /^[^@\s/]+@([^:\s/]+):/.exec(url)?.[1]?.toLowerCase() ?? null
}

export async function originHost(repoRoot: string): Promise<string | null> {
  try {
    return remoteHost(await git(repoRoot, ['remote', 'get-url', 'origin']))
  } catch {
    return null
  }
}

async function branchTaken(repoRoot: string, branch: string): Promise<boolean> {
  const refs = await git(repoRoot, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/heads/${branch}`,
    `refs/remotes/*/${branch}`,
  ])
  return refs.trim().length > 0
}

export async function ensureWorktreeIgnore(repoRoot: string, root: string): Promise<void> {
  const rel = relative(resolve(repoRoot), resolve(root))
  if (rel.startsWith('..') || rel === '') return
  const excludeLine = `/${rel.replace(/\\/g, '/')}/`
  const gitDir = (await git(repoRoot, ['rev-parse', '--git-common-dir'])).trim()
  const excludePath = resolve(repoRoot, gitDir, 'info', 'exclude')
  let current = ''
  try {
    current = await readFile(excludePath, 'utf8')
  } catch {
    await mkdir(resolve(excludePath, '..'), { recursive: true })
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === excludeLine)) return
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  await appendFile(excludePath, `${prefix}${excludeLine}\n`, 'utf8')
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
  root: string
  title: string
  base: string
  others?: readonly { repoRoot: string; root: string }[]
  branch?: string
}): Promise<Worktree> {
  return serialise(async () => {
    const repos = [{ repoRoot: input.repoRoot, root: input.root }, ...(input.others ?? [])]
    const held = new Set(
      (await Promise.all(repos.map((repo) => listWorktrees(repo.repoRoot)))).flat().map((tree) => tree.path.toLowerCase()),
    )
    const free = async (branch: string): Promise<boolean> => {
      for (const repo of repos) {
        const path = worktreePathFor(repo.root, branch)
        if (held.has(resolve(path).toLowerCase()) || existsSync(path)) return false
        if (await branchTaken(repo.repoRoot, branch)) return false
      }
      return true
    }
    const slug = slugify(input.title)
    let branch = input.branch ?? `feature/${slug}`
    for (let n = 2; !input.branch && !(await free(branch)); n += 1) branch = `feature/${slug}-${n}`
    const path = worktreePathFor(input.root, branch)
    await ensureWorktreeIgnore(input.repoRoot, input.root)
    await mkdir(input.root, { recursive: true })
    await git(input.repoRoot, ['-c', 'core.longpaths=true', 'worktree', 'add', '-b', branch, '--', path, input.base])
    await git(path, ['config', 'core.longpaths', 'true']).catch(() => '')
    const made = (await listWorktrees(input.repoRoot)).find(
      (tree) => tree.path.toLowerCase() === resolve(path).toLowerCase(),
    )
    if (!made) throw new Error(`git reported no worktree at ${path} after creating it.`)
    return made
  })
}

export async function removeWorktree(
  repoRoot: string,
  path: string,
  opts?: { force?: boolean; deleteBranch?: string },
): Promise<{ removed: boolean; dirty: string[] }> {
  return serialise(async () => {
    const dropBranch = async (): Promise<void> => {
      if (opts?.deleteBranch) await git(repoRoot, ['branch', '-D', '--', opts.deleteBranch]).catch(() => '')
    }
    if (!existsSync(path)) {
      await git(repoRoot, ['worktree', 'prune']).catch(() => '')
      await dropBranch()
      return { removed: true, dirty: [] }
    }
    const dirty = opts?.force === true ? [] : await worktreeDirty(path).catch(() => [])
    if (dirty.length > 0) return { removed: false, dirty }
    const args = ['worktree', 'remove', ...(opts?.force === true ? ['--force'] : []), '--', path]
    try {
      await git(repoRoot, args)
    } catch {
      await delay(500)
      await git(repoRoot, args)
    }
    await git(repoRoot, ['worktree', 'prune']).catch(() => '')
    await dropBranch()
    return { removed: true, dirty: [] }
  })
}
