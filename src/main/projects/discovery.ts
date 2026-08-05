// Project registration (FR-001) and Claude Code project suggestions (FR-001a).
// Suggestions are decoded from %USERPROFILE%\.claude\projects\: folder names
// are ambiguous (path separators and colons both become '-'), so the reliable
// source is the `cwd` field carried in each session's JSONL lines. Verified
// against the installed Claude Code version on 2026-07-19.
import { existsSync, statSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Project, ProjectRef } from '@shared/domain'
import type { IpcError, ProjectSuggestion } from '@shared/ipc-types'
import type { Repositories } from '@main/store/repositories'

// No DiscoveryError class: nothing did an instanceof check on it and nothing read
// its stack, so it was a subclass carrying no information the plain
// { code, message } shape does not. That shape is what the IPC layer throws
// everywhere else, and isIpcError duck-types on it.

export function registerProject(
  repos: Repositories,
  input: {
    path: string
    name?: string
    source?: Project['source']
    defaultSessionMode?: Project['defaultSessionMode']
  },
): Project {
  const path = resolve(input.path.trim().replace(/^~(?=$|[\\/])/, homedir()))
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw { code: 'INVALID_PATH', message: 'The folder does not exist' } satisfies IpcError
  }
  const existing = repos.projects.byPath(path)
  if (existing) {
    if (existing.archivedAt === null) {
      throw { code: 'DUPLICATE', message: 'The folder is already registered' } satisfies IpcError
    }
    // Re-adding a previously removed folder: restore the archived row (the
    // path is UNIQUE, so inserting would fail) — the project keeps its id,
    // history, and standing rules.
    repos.projects.unarchive(existing.id)
    const name = input.name?.trim()
    if (name) repos.projects.rename(existing.id, name)
    // Re-adding through the dialogue means the developer just chose a mode for
    // this folder, so it wins over the one the archived row was carrying. Adding
    // it back without choosing (no mode in the request) keeps what it had.
    const mode = input.defaultSessionMode
    if (mode) repos.projects.setSessionMode(existing.id, mode)
    return {
      ...existing,
      archivedAt: null,
      name: name || existing.name,
      defaultSessionMode: mode ?? existing.defaultSessionMode,
    }
  }
  const project = repos.projects.insert({
    name: input.name?.trim() || basename(path),
    path,
    source: input.source ?? 'manual',
    defaultSessionMode: input.defaultSessionMode,
  })
  seedFolderAccessRules(repos, project.id, path)
  return project
}

/**
 * Points an existing project at a different folder (context menu "Change
 * folder…"). Exists because fixing a project registered at the wrong folder — a
 * wrapper above the real clone, say — used to mean closing the app and editing
 * the database by hand. The project keeps its id, sessions, and eval history;
 * the seeded folder-access rules move with the folder, since a glob scoped to
 * the old one would make every read in the new one prompt.
 */
export function repointProject(repos: Repositories, projectId: string, rawPath: string): Project {
  const project = repos.projects.byId(projectId)
  if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
  if (repos.sessions.activeForProject(projectId)) {
    // A live session (native cwd or container bind mount) is standing in the old
    // folder; repointing under it would leave the row lying about where it ran.
    throw { code: 'ALREADY_ACTIVE', message: 'Stop the session before changing the folder' } satisfies IpcError
  }
  const path = resolve(rawPath.trim().replace(/^~(?=$|[\\/])/, homedir()))
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw { code: 'INVALID_PATH', message: 'The folder does not exist' } satisfies IpcError
  }
  if (path === project.path) return project
  const owner = repos.projects.byPath(path)
  if (owner && owner.id !== projectId) {
    // Archived rows count too: path is UNIQUE, so the update would throw anyway.
    throw { code: 'DUPLICATE', message: 'The folder is already registered' } satisfies IpcError
  }
  repos.projects.setPath(projectId, path)
  // Only the auto-seeded access rules move; rules the developer created from
  // real permission requests are theirs and stay put.
  for (const rule of repos.standingRules.listForProject(projectId)) {
    if (rule.createdFromRequestId === 'auto:folder-access') repos.standingRules.revoke(rule.id)
  }
  seedFolderAccessRules(repos, projectId, path)
  return { ...project, path }
}

/**
 * Adds a REFS entry (design: header chips): `target` is a folder path or the
 * name of another registered project. Returns the updated ref list.
 */
export function addProjectRef(
  repos: Repositories,
  projectId: string,
  target: string,
): ProjectRef[] {
  const project = repos.projects.byId(projectId)
  if (!project) throw { code: 'INVALID_PATH', message: 'Project not found' } satisfies IpcError
  const trimmed = target.trim()
  if (!trimmed) throw { code: 'INVALID_PATH', message: 'Enter a folder path or a project name' } satisfies IpcError

  // A project name wins over a path spelling; otherwise treat it as a folder.
  const active = repos.projects.listActive()
  const named = active.find(
    (p) => p.id !== projectId && p.name.toLowerCase() === trimmed.toLowerCase(),
  )
  const path = named ? named.path : resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir()))
  if (!named && (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory())) {
    throw { code: 'INVALID_PATH', message: 'The folder does not exist' } satisfies IpcError
  }
  if (path === project.path) {
    throw { code: 'DUPLICATE', message: 'The project already reads its own folder' } satisfies IpcError
  }
  // A path that belongs to a registered project keeps that project's name.
  const owner = named ?? active.find((p) => p.path === path)
  const refs = project.refs.filter((r) => r.path !== path)
  refs.push({ path, label: owner ? owner.name : basename(path) })
  repos.projects.setRefs(projectId, refs)
  return refs
}

/** Removes a REFS entry by path. Returns the updated ref list. */
export function removeProjectRef(
  repos: Repositories,
  projectId: string,
  path: string,
): ProjectRef[] {
  const project = repos.projects.byId(projectId)
  if (!project) throw { code: 'INVALID_PATH', message: 'Project not found' } satisfies IpcError
  const refs = project.refs.filter((r) => r.path !== path)
  repos.projects.setRefs(projectId, refs)
  return refs
}

/**
 * Grant read/write access to a new project's own folder by seeding standing
 * always-allow rules for the file tools, scoped to a glob under the folder.
 * They are listed and revocable like any standing rule (FR-009b).
 */
function seedFolderAccessRules(repos: Repositories, projectId: string, path: string): void {
  const glob = `${path.replace(/[\\/]+$/, '')}${path.includes('\\') ? '\\' : '/'}**`
  for (const toolName of ['Read', 'Write', 'Edit', 'NotebookEdit']) {
    repos.standingRules.insert({
      projectId,
      toolName,
      matcher: { kind: 'path_glob', value: glob },
      createdFromRequestId: 'auto:folder-access',
    })
  }
}

// Only the head of each JSONL needs scanning — the `cwd` field is on the first
// line. Bounding the read keeps a large session log from being slurped whole.
const CWD_SCAN_BYTES = 64 * 1024

async function cwdFromJsonl(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(CWD_SCAN_BYTES), 0, CWD_SCAN_BYTES, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown }
        if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) return parsed.cwd
      } catch {
        // Malformed (or truncated tail) line; keep scanning.
      }
    }
  } catch {
    // Unreadable file; no suggestion from this entry.
  } finally {
    await handle?.close()
  }
  return null
}

// ~/.claude/projects accumulates every folder Claude Code has ever run in, and
// an add-project picker listing hundreds of them alphabetically buries the one
// folder the developer actually means. Only the most recently used survive.
const MAX_SUGGESTIONS = 10

/**
 * Suggest Claude Code project folders from ~/.claude/projects, most recently
 * used first, capped at MAX_SUGGESTIONS. Fully async (fs/promises) so this
 * multi-directory scan never blocks the main-process event loop, however many
 * projects or how large their logs.
 */
export async function suggestProjects(
  repos: Repositories,
  claudeProjectsDir = join(homedir(), '.claude', 'projects'),
): Promise<ProjectSuggestion[]> {
  const registered = new Set(repos.projects.listActive().map((p) => p.path.toLowerCase()))
  const suggestions = new Map<string, ProjectSuggestion & { mtime: number }>()

  let dirents
  try {
    dirents = await readdir(claudeProjectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of dirents) {
    if (!entry.isDirectory()) continue
    const dir = join(claudeProjectsDir, entry.name)
    let jsonlFiles: { path: string; mtime: number }[]
    try {
      const names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
      jsonlFiles = (
        await Promise.all(
          names.map(async (f) => {
            const full = join(dir, f)
            return { path: full, mtime: (await stat(full)).mtimeMs }
          }),
        )
      ).sort((a, b) => b.mtime - a.mtime)
    } catch {
      continue
    }

    for (const file of jsonlFiles.slice(0, 3)) {
      const cwd = await cwdFromJsonl(file.path)
      if (!cwd) continue
      const path = resolve(cwd)
      const key = path.toLowerCase()
      if (registered.has(key)) break
      const seen = suggestions.get(key)
      if (seen) {
        // Two ~/.claude/projects folders can decode to the same cwd (a renamed
        // or re-cased path); the folder ranks by the newest session across both.
        seen.mtime = Math.max(seen.mtime, file.mtime)
        break
      }
      const isDir = await stat(path)
        .then((s) => s.isDirectory())
        .catch(() => false)
      if (!isDir) break
      suggestions.set(key, { path, name: basename(path), mtime: file.mtime })
      break
    }
  }

  return [...suggestions.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ path, name }) => ({ path, name }))
}
