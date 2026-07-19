// Project registration (FR-001) and Claude Code project suggestions (FR-001a).
// Suggestions are decoded from %USERPROFILE%\.claude\projects\: folder names
// are ambiguous (path separators and colons both become '-'), so the reliable
// source is the `cwd` field carried in each session's JSONL lines. Verified
// against the installed Claude Code version on 2026-07-19.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Project } from '@shared/domain'
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
  const path = resolve(input.path)
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw new DiscoveryError('INVALID_PATH', 'The folder does not exist')
  }
  const existing = repos.projects.byPath(path)
  if (existing && existing.archivedAt === null) {
    throw new DiscoveryError('DUPLICATE', 'The folder is already registered')
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

const CWD_SCAN_LINES = 50

function cwdFromJsonl(filePath: string): string | null {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n', CWD_SCAN_LINES)
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown }
        if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) return parsed.cwd
      } catch {
        // Malformed line; keep scanning.
      }
    }
  } catch {
    // Unreadable file; no suggestion from this entry.
  }
  return null
}

export function suggestProjects(
  repos: Repositories,
  claudeProjectsDir = join(homedir(), '.claude', 'projects'),
): ProjectSuggestion[] {
  if (!existsSync(claudeProjectsDir)) return []
  const registered = new Set(repos.projects.listActive().map((p) => p.path.toLowerCase()))
  const suggestions = new Map<string, ProjectSuggestion>()

  for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(claudeProjectsDir, entry.name)
    let jsonlFiles: { path: string; mtime: number }[]
    try {
      jsonlFiles = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = join(dir, f)
          return { path: full, mtime: statSync(full).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
    } catch {
      continue
    }

    for (const file of jsonlFiles.slice(0, 3)) {
      const cwd = cwdFromJsonl(file.path)
      if (!cwd) continue
      const path = resolve(cwd)
      const key = path.toLowerCase()
      if (registered.has(key) || suggestions.has(key)) break
      if (!existsSync(path) || !statSync(path).isDirectory()) break
      suggestions.set(key, { path, name: basename(path) })
      break
    }
  }

  return [...suggestions.values()].sort((a, b) => a.name.localeCompare(b.name))
}
