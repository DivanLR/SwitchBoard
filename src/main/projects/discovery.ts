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
import type { ProjectSuggestion } from '@shared/ipc-types'
import type { Repositories } from '@main/store/repositories'

export class DiscoveryError extends Error {
  constructor(
    public code: 'INVALID_PATH' | 'DUPLICATE',
    message: string,
  ) {
    super(message)
  }
}

export function registerProject(
  repos: Repositories,
  input: { path: string; name?: string; source?: Project['source'] },
): Project {
  const path = resolve(input.path.trim().replace(/^~(?=$|[\\/])/, homedir()))
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw new DiscoveryError('INVALID_PATH', 'The folder does not exist')
  }
  const existing = repos.projects.byPath(path)
  if (existing) {
    if (existing.archivedAt === null) {
      throw new DiscoveryError('DUPLICATE', 'The folder is already registered')
    }
    // Re-adding a previously removed folder: restore the archived row (the
    // path is UNIQUE, so inserting would fail) — the project keeps its id,
    // history, and standing rules.
    repos.projects.unarchive(existing.id)
    const name = input.name?.trim()
    if (name) repos.projects.rename(existing.id, name)
    return { ...existing, archivedAt: null, name: name || existing.name }
  }
  const project = repos.projects.insert({
    name: input.name?.trim() || basename(path),
    path,
    source: input.source ?? 'manual',
  })
  seedFolderAccessRules(repos, project.id, path)
  return project
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
  if (!project) throw new DiscoveryError('INVALID_PATH', 'Project not found')
  const trimmed = target.trim()
  if (!trimmed) throw new DiscoveryError('INVALID_PATH', 'Enter a folder path or a project name')

  // A project name wins over a path spelling; otherwise treat it as a folder.
  const active = repos.projects.listActive()
  const named = active.find(
    (p) => p.id !== projectId && p.name.toLowerCase() === trimmed.toLowerCase(),
  )
  const path = named ? named.path : resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir()))
  if (!named && (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory())) {
    throw new DiscoveryError('INVALID_PATH', 'The folder does not exist')
  }
  if (path === project.path) {
    throw new DiscoveryError('DUPLICATE', 'The project already reads its own folder')
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
  if (!project) throw new DiscoveryError('INVALID_PATH', 'Project not found')
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

/**
 * Suggest Claude Code project folders from ~/.claude/projects. Fully async
 * (fs/promises) so this multi-directory scan never blocks the main-process
 * event loop, however many projects or how large their logs.
 */
export async function suggestProjects(
  repos: Repositories,
  claudeProjectsDir = join(homedir(), '.claude', 'projects'),
): Promise<ProjectSuggestion[]> {
  const registered = new Set(repos.projects.listActive().map((p) => p.path.toLowerCase()))
  const suggestions = new Map<string, ProjectSuggestion>()

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
      if (registered.has(key) || suggestions.has(key)) break
      const isDir = await stat(path)
        .then((s) => s.isDirectory())
        .catch(() => false)
      if (!isDir) break
      suggestions.set(key, { path, name: basename(path) })
      break
    }
  }

  return [...suggestions.values()].sort((a, b) => a.name.localeCompare(b.name))
}
