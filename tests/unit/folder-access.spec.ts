// Registering a project seeds read/write standing rules for its own folder.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@shared/domain'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { registerProject, repointProject } from '@main/projects/discovery'
import { isPathWithinProject, matchesRule } from '@main/inbox/standing-rules'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('registerProject folder-access seeding', () => {
  it('seeds standing allow rules for the file tools scoped to the folder', () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const folder = mkdtempSync(join(tmpdir(), 'fa-'))
    dirs.push(folder)

    const project = registerProject(repos, { path: folder })
    const rules = repos.standingRules.listForProject(project.id)
    const tools = rules.map((r) => r.toolName).sort()
    expect(tools).toEqual(['Edit', 'NotebookEdit', 'Read', 'Write'])

    // A read inside the folder matches; a read outside does not.
    const readRule = rules.find((r) => r.toolName === 'Read')!
    expect(matchesRule(readRule, 'Read', { file_path: join(folder, 'src', 'a.ts') })).toBe(true)
    expect(matchesRule(readRule, 'Read', { file_path: 'C:\\elsewhere\\secret.txt' })).toBe(false)
  })

  it('re-adding a removed folder restores it instead of hitting the UNIQUE constraint', () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const folder = mkdtempSync(join(tmpdir(), 'fa-'))
    dirs.push(folder)

    const first = registerProject(repos, { path: folder })
    repos.projects.archive(first.id)
    expect(repos.projects.listActive()).toHaveLength(0)

    // Previously threw "UNIQUE constraint failed: projects.path".
    const again = registerProject(repos, { path: folder, name: 'renamed' })
    expect(again.id).toBe(first.id)
    expect(again.archivedAt).toBeNull()
    expect(again.name).toBe('renamed')
    expect(repos.projects.listActive()).toHaveLength(1)

    // An active duplicate is still rejected.
    expect(() => registerProject(repos, { path: folder })).toThrowError(/already registered/)
  })
})

/**
 * Containment must survive a link, not just a `..`.
 *
 * The containment check used to compare paths LEXICALLY: resolve() collapses
 * `.` and `..` but does not follow a symbolic link, so a link sitting inside the
 * project resolved as being inside it. That is the one escape that mattered,
 * because the file tools inside a project folder are auto-approved WITHOUT an
 * inbox prompt — so a Write through the link left the project silently, which is
 * exactly the containment this app exists to provide. Git creates links on
 * checkout when core.symlinks is on, so this is a repository's contents, not an
 * exotic setup.
 *
 * Both halves are asserted deliberately. A check that rejects the link is easy
 * to write by rejecting far too much, and the second case is what proves it did
 * not: a file that does not exist yet is the ordinary case for Write, and it has
 * no realpath of its own to resolve.
 */
describe('project containment follows symbolic links', () => {
  /** Returns false when the platform refuses to make one at all — Windows needs
   *  developer mode or elevation for a file symlink, so the test states that it
   *  could not run rather than passing without having checked anything. */
  function linkOrSkip(target: string, path: string): boolean {
    try {
      // 'junction' is the Windows spelling that needs no privilege; it is
      // ignored on POSIX, where 'dir' is the same thing.
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
      return true
    } catch {
      return false
    }
  }

  it('rejects a path that leaves the project through a link inside it', () => {
    const project = mkdtempSync(join(tmpdir(), 'fa-link-project-'))
    const outside = mkdtempSync(join(tmpdir(), 'fa-link-outside-'))
    dirs.push(project, outside)
    writeFileSync(join(outside, 'secret.txt'), 'not the project\'s to write')

    const link = join(project, 'escape')
    if (!linkOrSkip(outside, link)) {
      console.warn('skipped: this platform refused to create a link (Windows needs developer mode)')
      return
    }

    // Lexically inside the project. Actually somewhere else entirely.
    expect(isPathWithinProject(project, { file_path: join(link, 'secret.txt') })).toBe(false)

    // And the seeded path_glob rule, which is the other door onto the same check.
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const registered = registerProject(repos, { path: project })
    const writeRule = repos.standingRules
      .listForProject(registered.id)
      .find((r) => r.toolName === 'Write')!
    expect(matchesRule(writeRule, 'Write', { file_path: join(link, 'secret.txt') })).toBe(false)
  })

  it('still allows a file that does not exist yet, which is what Write asks about', () => {
    const project = mkdtempSync(join(tmpdir(), 'fa-new-file-'))
    dirs.push(project)
    // Nothing on disk at any level below the project root.
    expect(isPathWithinProject(project, { file_path: join(project, 'src', 'new', 'a.ts') })).toBe(true)
  })
})

// Repointing exists because fixing a project registered at the wrong folder (a
// wrapper above the real clone, say) used to mean closing the app and editing
// the database by hand. The seeded folder-access rules are path globs, so they
// must follow the folder — or every read in the new one prompts.
describe('repointProject', () => {
  const liveSession = (projectId: string): Session => ({
    id: `s-${projectId}`,
    projectId,
    sdkSessionId: null,
    status: 'working',
    statusDetail: null,
    branch: null,
    diffAdds: null,
    diffDels: null,
    usageUtilization: null,
    usageResetsAt: null,
    usageLimitType: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
  })

  it('updates the path and moves the auto folder-access rules with it', () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const oldFolder = mkdtempSync(join(tmpdir(), 'fa-old-'))
    const newFolder = mkdtempSync(join(tmpdir(), 'fa-new-'))
    dirs.push(oldFolder, newFolder)

    const project = registerProject(repos, { path: oldFolder })
    const updated = repointProject(repos, project.id, newFolder)
    expect(updated.path).toBe(newFolder)
    expect(repos.projects.byId(project.id)?.path).toBe(newFolder)

    // The seeded rules now grant the new folder and no longer grant the old one.
    const readRule = repos.standingRules
      .listForProject(project.id)
      .find((r) => r.toolName === 'Read')!
    expect(matchesRule(readRule, 'Read', { file_path: join(newFolder, 'a.ts') })).toBe(true)
    expect(matchesRule(readRule, 'Read', { file_path: join(oldFolder, 'a.ts') })).toBe(false)
  })

  it('rejects a missing folder, a live session, and another project\'s folder', () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const folderA = mkdtempSync(join(tmpdir(), 'fa-a-'))
    const folderB = mkdtempSync(join(tmpdir(), 'fa-b-'))
    dirs.push(folderA, folderB)

    const a = registerProject(repos, { path: folderA })
    const b = registerProject(repos, { path: folderB })

    expect(() => repointProject(repos, a.id, join(folderA, 'nope'))).toThrowError(/does not exist/)
    expect(() => repointProject(repos, a.id, folderB)).toThrowError(/already registered/)
    expect(repos.projects.byId(a.id)?.path).toBe(folderA)

    repos.sessions.insert(liveSession(b.id))
    expect(() => repointProject(repos, b.id, folderA)).toThrowError(/Stop the session/)
  })

  it('is a no-op when pointed at the folder it already reads', () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const folder = mkdtempSync(join(tmpdir(), 'fa-same-'))
    dirs.push(folder)

    const project = registerProject(repos, { path: folder })
    const before = repos.standingRules.listForProject(project.id)
    expect(repointProject(repos, project.id, folder).path).toBe(folder)
    // Same rules, not revoked-and-reseeded.
    expect(repos.standingRules.listForProject(project.id)).toEqual(before)
  })
})
