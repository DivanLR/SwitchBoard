// Importing skills from a GitHub repository, over HTTPS, without running any of
// it.
//
// WHY NOT `git clone`, and why not the CLI's own plugin installer. The plugin
// path (sessions/plugin-install.ts) shells out to `claude plugin marketplace add`,
// which clones a repository and can execute what it finds; that is exactly why
// handlers.ts guards it with ALLOWED_PLUGINS and refuses any pair the app does
// not itself offer. This feature is the opposite by definition — the developer
// names the repository — so an allowlist is not available as a control, and the
// safety has to come from the mechanism instead:
//
//   - Two GET requests' worth of machinery and nothing else. No child process, no
//     shell, no archive extractor, so nothing in the repository is executed at
//     import time and a hostile repository has no code path to run in.
//   - github.com only, and every component of the URL validated against a strict
//     character class before it reaches a request.
//   - Every path from the tree re-checked against traversal and absolute forms
//     before it becomes a filename, because the tree is remote data.
//   - Hard caps on file count and byte size, so a repository cannot fill a disk.
//
// What this CANNOT defend against is the skill's own instructions: a skill is a
// prompt, and a prompt can tell a session to do something the developer would not
// want. That risk is inherent in the feature and is why an imported skill is
// listed with its source and can be switched off in one click, rather than being
// silently trusted for ever.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import type { CustomSkill, SkillImportResult } from '@shared/domain'
import type { IpcError } from '@shared/ipc-types'
import { isSafeRepoPath, isSafeSegment, readSkillSource, type SkillSource } from '@shared/skill-source'

export { isSafeRepoPath, type SkillSource }

/** A repository can be large; a skills folder is not. Both caps are per import. */
const MAX_FILES = 400
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
/** One file. A SKILL.md is prose and a helper script is small; a 2 MB "skill file"
 *  is something else wearing the name. */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000

/**
 * Read a GitHub URL into its parts, or throw the IpcError the endpoint answers with.
 *
 * The rules themselves live in `@shared/skill-source` so the renderer can apply
 * the same ones to the field as it is typed — it reports what a URL names, or why
 * it will be refused, before any request is made. This is the throwing face of
 * that one implementation, kept because every caller here is inside a handler
 * where a throw IS the error path.
 */
export function parseSkillSource(input: string): SkillSource {
  const result = readSkillSource(input)
  if (!result.ok) throw { code: 'INVALID_PATH', message: result.message } satisfies IpcError
  return result.source
}

interface TreeEntry {
  path: string
  type: string
  size?: number
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

/** The repository's whole file list in one request, rather than one request per
 *  directory: a skills folder is a handful of files but the walk to find them is
 *  not, and 60 unauthenticated requests an hour does not survive a walk. */
async function readTree(source: SkillSource): Promise<TreeEntry[]> {
  const ref = source.ref ?? (await defaultBranch(source))
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  const body = (await getJson(url)) as { tree?: TreeEntry[]; truncated?: boolean }
  if (!Array.isArray(body.tree)) {
    throw { code: 'NOT_FOUND', message: 'GitHub returned no file list for that ref.' } satisfies IpcError
  }
  if (body.truncated) {
    // Said rather than silently importing a subset: a truncated tree means the
    // skill the developer wanted may simply not be in the half that arrived.
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

/** Frontmatter `name` and `description`, which is all this app reads out of a
 *  SKILL.md. Deliberately not a YAML parser: two scalar fields do not earn a
 *  dependency, and a skill whose frontmatter needs one is a skill this cannot
 *  describe honestly anyway. */
export function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  // The byte-order mark is written as an escape and never as the character:
  // a literal one is invisible in a diff, which is why lint refuses it.
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

/** A skill's directory name has to be safe as a folder AND usable as the slash
 *  command the CLI derives from it. */
export function isUsableSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
}

async function download(source: SkillSource, ref: string, path: string): Promise<Buffer> {
  const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(ref)}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'switchboard' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw { code: 'NOT_FOUND', message: `Could not read ${path} (${response.status}).` } satisfies IpcError
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw { code: 'INVALID_PATH', message: `${path} is larger than this imports.` } satisfies IpcError
  }
  return buffer
}

/**
 * Find every skill in the repository under the requested path and write each into
 * its own directory beneath `stagingRoot`.
 *
 * A skill is any directory that DIRECTLY contains a SKILL.md, which is the same
 * rule the CLI itself uses. Everything alongside that file travels with it —
 * references, scripts, templates — because a skill that arrives without its own
 * supporting files is a skill that fails on first use.
 *
 * `existing` names the skills already registered, so a repeat import reports a
 * clash rather than overwriting a skill the developer may have come to rely on.
 */
export async function importSkills(
  input: string,
  stagingRoot: string,
  existing: ReadonlySet<string>,
): Promise<SkillImportResult> {
  const source = parseSkillSource(input)
  const ref = source.ref ?? (await defaultBranch(source))
  const tree = await readTree({ ...source, ref })

  const prefix = source.path === '' ? '' : `${source.path}/`
  const inScope = tree.filter(
    (entry) => entry.type === 'blob' && entry.path.startsWith(prefix) && isSafeRepoPath(entry.path),
  )

  // Every directory holding a SKILL.md, and the files that belong to each.
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
  let budgetFiles = MAX_FILES
  let budgetBytes = MAX_TOTAL_BYTES

  for (const dir of skillDirs) {
    const files = inScope.filter((entry) => posix.dirname(entry.path) === dir || entry.path.startsWith(`${dir}/`))
    const label = posix.basename(dir)
    const manifest = files.find((entry) => posix.basename(entry.path) === 'SKILL.md' && posix.dirname(entry.path) === dir)
    if (!manifest) continue

    const front = parseSkillFrontmatter((await download(source, ref, manifest.path)).toString('utf8'))
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
    if (files.length > budgetFiles) {
      skipped.push({ name: front.name, reason: 'This import already reached its file limit.' })
      continue
    }

    const target = join(stagingRoot, front.name)
    // A half-written skill is worse than none: the directory is removed and
    // rebuilt so a retry after a failed download cannot leave a mixture.
    await rm(target, { recursive: true, force: true })
    let written = 0
    try {
      for (const file of files) {
        const relative = file.path.slice(dir.length + 1)
        if (!isSafeRepoPath(relative)) continue
        const bytes = await download(source, ref, file.path)
        budgetBytes -= bytes.byteLength
        if (budgetBytes < 0) {
          throw { code: 'INVALID_PATH', message: 'That import is larger than this allows.' } satisfies IpcError
        }
        const destination = join(target, relative)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, bytes)
        written += 1
      }
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      throw error
    }
    budgetFiles -= written

    imported.push({
      name: front.name,
      description: front.description,
      sourceUrl: input.trim(),
      sourcePath: dir,
      // Switched on as they arrive. The developer asked for this repository by
      // name; landing ten skills all switched off would recreate exactly the
      // manual step the feature exists to remove.
      enabled: true,
      fileCount: written,
      importedAt: new Date().toISOString(),
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

/** Read a staged skill's own description again, for a re-scan that does not
 *  re-download. Absent or unreadable answers null rather than throwing: a
 *  listing must not fail because one directory was deleted by hand. */
export async function readStagedDescription(stagingRoot: string, name: string): Promise<string | null> {
  try {
    const text = await readFile(join(stagingRoot, name, 'SKILL.md'), 'utf8')
    return parseSkillFrontmatter(text)?.description ?? null
  } catch {
    return null
  }
}
