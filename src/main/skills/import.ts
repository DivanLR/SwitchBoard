import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { CustomSkill, SkillImportResult } from '@shared/domain'
import type { IpcError } from '@shared/ipc-types'
import { isSafeRepoPath, isSafeSegment, readSkillSource, type SkillSource } from '@shared/skill-source'

const MAX_FILES = 400
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000
const DOWNLOAD_ATTEMPTS = 3
const RETRY_PAUSE_MS = 400

export function parseSkillSource(input: string): SkillSource {
  const result = readSkillSource(input)
  if (!result.ok) throw { code: 'INVALID_PATH', message: result.message } satisfies IpcError
  return result.source
}

interface TreeEntry {
  path: string
  type: string
  size?: number
  sha?: string
}

interface SourceListing {
  source: SkillSource
  ref: string
  inScope: TreeEntry[]
  oversized: TreeEntry[]
}

async function listSource(input: string): Promise<SourceListing> {
  const source = parseSkillSource(input)
  const ref = source.ref ?? (await defaultBranch(source))
  const tree = await readTree({ ...source, ref })
  const prefix = source.path === '' ? '' : `${source.path}/`
  const blobs = tree.filter(
    (entry) => entry.type === 'blob' && entry.path.startsWith(prefix) && isSafeRepoPath(entry.path),
  )
  return {
    source,
    ref,
    inScope: blobs.filter((entry) => (entry.size ?? 0) <= MAX_FILE_BYTES),
    oversized: blobs.filter((entry) => (entry.size ?? 0) > MAX_FILE_BYTES),
  }
}

function skillFiles(inScope: readonly TreeEntry[], base: string): (TreeEntry & { relative: string })[] {
  const files = base === '' ? inScope : inScope.filter((entry) => entry.path.startsWith(`${base}/`))
  return files
    .map((file) => ({ ...file, relative: base === '' ? file.path : file.path.slice(base.length + 1) }))
    .filter((file) => isSafeRepoPath(file.relative))
}

export async function remoteSkillShas(
  input: string,
): Promise<(sourcePath: string) => Map<string, string>> {
  const { inScope } = await listSource(input)
  return (sourcePath) =>
    new Map(skillFiles(inScope, sourcePath).map((file) => [file.relative, file.sha ?? '']))
}

export async function folderShas(dir: string): Promise<Map<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  const files = entries.filter((entry) => entry.isFile())
  return new Map(
    await Promise.all(
      files.map(async (entry): Promise<[string, string]> => {
        const full = join(entry.parentPath, entry.name)
        const bytes = await readFile(full)
        const sha = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
        return [relative(dir, full).split(sep).join('/'), sha]
      }),
    ),
  )
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'switchboard' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (response.status === 403 || response.status === 429) {
    throw {
      code: 'RULE_NOT_ALLOWED',
      message: "GitHub is rate-limiting this machine. Wait a few minutes and try again.",
    } satisfies IpcError
  }
  if (response.status === 404) {
    throw {
      code: 'NOT_FOUND',
      message: 'GitHub has no such repository, branch or folder.',
    } satisfies IpcError
  }
  if (!response.ok) {
    throw { code: 'INVALID_PATH', message: `GitHub answered ${response.status}.` } satisfies IpcError
  }
  return response.json()
}

async function readTree(source: SkillSource): Promise<TreeEntry[]> {
  const ref = source.ref ?? (await defaultBranch(source))
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  const body = (await getJson(url)) as { tree?: TreeEntry[]; truncated?: boolean }
  if (!Array.isArray(body.tree)) {
    throw { code: 'NOT_FOUND', message: 'GitHub returned no file list for that ref.' } satisfies IpcError
  }
  if (body.truncated) {
    throw {
      code: 'INVALID_PATH',
      message: 'That repository is too large to list. Link the skills folder directly with a /tree/ URL.',
    } satisfies IpcError
  }
  return body.tree
}

async function defaultBranch(source: SkillSource): Promise<string> {
  const body = (await getJson(
    `https://api.github.com/repos/${source.owner}/${source.repo}`,
  )) as { default_branch?: string }
  const branch = body.default_branch
  if (!branch || !isSafeSegment(branch)) {
    throw { code: 'NOT_FOUND', message: 'That repository has no readable default branch.' } satisfies IpcError
  }
  return branch
}

export function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return null
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  const name = fields.name
  if (!name) return null
  return { name, description: fields.description ?? '' }
}

export function isUsableSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
}

async function download(source: SkillSource, ref: string, path: string): Promise<Buffer> {
  const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(ref)}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  let last = 0
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await delay(RETRY_PAUSE_MS * (attempt - 1))
    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'switchboard' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      last = 0
      continue
    }
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength > MAX_FILE_BYTES) {
        throw { code: 'INVALID_PATH', message: `${path} is larger than this imports.` } satisfies IpcError
      }
      return buffer
    }
    last = response.status
    if (response.status === 404) break
  }
  throw {
    code: 'NOT_FOUND',
    message: `Could not read ${path} (${last === 0 ? 'no response' : last}).`,
  } satisfies IpcError
}

export async function importSkills(
  input: string,
  stagingRoot: string,
  existing: ReadonlySet<string>,
  only?: string,
): Promise<SkillImportResult> {
  const { source, ref, inScope, oversized } = await listSource(input)

  const skillDirs = inScope
    .filter((entry) => posix.basename(entry.path) === 'SKILL.md')
    .map((entry) => posix.dirname(entry.path))
  if (skillDirs.length === 0) {
    throw {
      code: 'NOT_FOUND',
      message: 'No SKILL.md found there. Link the folder that holds the skills.',
    } satisfies IpcError
  }

  const imported: CustomSkill[] = []
  const skipped: { name: string; reason: string }[] = []
  const incoming: { from: string; to: string }[] = []
  let budgetFiles = MAX_FILES
  let budgetBytes = MAX_TOTAL_BYTES

  try {
    for (const dir of skillDirs) {
      const base = dir === '.' ? '' : dir
      const files = skillFiles(inScope, base)
      const label = base === '' ? source.repo : posix.basename(base)

      const front = parseSkillFrontmatter((await download(source, ref, posix.join(dir, 'SKILL.md'))).toString('utf8'))
      if (only !== undefined && front?.name !== only) continue
      if (!front) {
        skipped.push({ name: label, reason: 'Its SKILL.md has no name in the frontmatter.' })
        continue
      }
      if (!isUsableSkillName(front.name)) {
        skipped.push({ name: front.name, reason: 'That name cannot be a folder or a slash command.' })
        continue
      }
      if (existing.has(front.name)) {
        skipped.push({ name: front.name, reason: 'A skill of that name is already imported.' })
        continue
      }
      if (imported.some((skill) => skill.name === front.name)) {
        skipped.push({ name: front.name, reason: 'Another skill in this import already has that name.' })
        continue
      }
      if (files.length > budgetFiles) {
        skipped.push({ name: front.name, reason: 'This import already reached its file limit.' })
        continue
      }

      const from = join(stagingRoot, `.incoming-${front.name}`)
      incoming.push({ from, to: join(stagingRoot, front.name) })
      await rm(from, { recursive: true, force: true })
      const filesBefore = budgetFiles
      for (const file of files) {
        const bytes = await download(source, ref, file.path)
        budgetBytes -= bytes.byteLength
        if (budgetBytes < 0) {
          throw { code: 'INVALID_PATH', message: 'That import is larger than this allows.' } satisfies IpcError
        }
        const destination = join(from, file.relative)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, bytes)
        budgetFiles -= 1
      }
      imported.push({
        name: front.name,
        description: front.description,
        sourceUrl: input.trim(),
        sourcePath: base,
        enabled: true,
        fileCount: filesBefore - budgetFiles,
        importedAt: new Date().toISOString(),
      })
    }
  } catch (error) {
    for (const { from } of incoming) await rm(from, { recursive: true, force: true })
    throw error
  }
  for (const { from, to } of incoming) {
    await rm(to, { recursive: true, force: true })
    await rename(from, to)
  }

  for (const entry of oversized) {
    skipped.push({
      name: entry.path,
      reason: `${Math.round((entry.size ?? 0) / (1024 * 1024))} MB is over the ${MAX_FILE_BYTES / (1024 * 1024)} MB file limit; the rest of the skill came in.`,
    })
  }

  if (imported.length === 0 && skipped.length > 0) {
    throw {
      code: 'INVALID_PATH',
      message: `Nothing could be imported: ${skipped[0].reason}`,
    } satisfies IpcError
  }
  return { imported, skipped }
}
