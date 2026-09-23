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

    const again = registerProject(repos, { path: folder, name: 'renamed' })
    expect(again.id).toBe(first.id)
    expect(again.archivedAt).toBeNull()
    expect(again.name).toBe('renamed')
    expect(repos.projects.listActive()).toHaveLength(1)

    expect(() => registerProject(repos, { path: folder })).toThrowError(/already registered/)
  })
})

describe('project containment follows symbolic links', () => {
  function linkOrSkip(target: string, path: string): boolean {
    try {
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

    expect(isPathWithinProject(project, { file_path: join(link, 'secret.txt') })).toBe(false)

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
    expect(isPathWithinProject(project, { file_path: join(project, 'src', 'new', 'a.ts') })).toBe(true)
  })
})

describe('repointProject', () => {
  const liveSession = (projectId: string): Session => ({
    id: `s-${projectId}`,
    projectId,
    engine: 'claude',
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
    expect(repos.standingRules.listForProject(project.id)).toEqual(before)
  })
})
