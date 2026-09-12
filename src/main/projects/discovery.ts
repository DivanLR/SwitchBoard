import { existsSync, statSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Project, ProjectRef } from '@shared/domain'
import type { IpcError, ProjectSuggestion } from '@shared/ipc-types'
import type { Repositories } from '@main/store/repositories'

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
    repos.projects.unarchive(existing.id)
    const name = input.name?.trim()
    if (name) repos.projects.rename(existing.id, name)
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

export function repointProject(repos: Repositories, projectId: string, rawPath: string): Project {
  const project = repos.projects.byId(projectId)
  if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
  if (repos.sessions.activeForProject(projectId)) {
    throw { code: 'ALREADY_ACTIVE', message: 'Stop the session before changing the folder' } satisfies IpcError
  }
  const path = resolve(rawPath.trim().replace(/^~(?=$|[\\/])/, homedir()))
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw { code: 'INVALID_PATH', message: 'The folder does not exist' } satisfies IpcError
  }
  if (path === project.path) return project
  const owner = repos.projects.byPath(path)
  if (owner && owner.id !== projectId) {
    throw { code: 'DUPLICATE', message: 'The folder is already registered' } satisfies IpcError
  }
  repos.projects.setPath(projectId, path)
  for (const rule of repos.standingRules.listForProject(projectId)) {
    if (rule.createdFromRequestId === 'auto:folder-access') repos.standingRules.revoke(rule.id)
  }
  seedFolderAccessRules(repos, projectId, path)
  return { ...project, path }
}

export function addProjectRef(
  repos: Repositories,
  projectId: string,
  target: string,
): ProjectRef[] {
  const project = repos.projects.byId(projectId)
  if (!project) throw { code: 'INVALID_PATH', message: 'Project not found' } satisfies IpcError
  const trimmed = target.trim()
  if (!trimmed) throw { code: 'INVALID_PATH', message: 'Enter a folder path or a project name' } satisfies IpcError

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
  const owner = named ?? active.find((p) => p.path === path)
  const refs = project.refs.filter((r) => r.path !== path)
  refs.push({ path, label: owner ? owner.name : basename(path) })
  repos.projects.setRefs(projectId, refs)
  return refs
}

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
      }
    }
  } catch {
  } finally {
    await handle?.close()
  }
  return null
}

const MAX_SUGGESTIONS = 10

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
