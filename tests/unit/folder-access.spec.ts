// Registering a project seeds read/write standing rules for its own folder.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { registerProject } from '@main/projects/discovery'
import { matchesRule } from '@main/inbox/standing-rules'

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
