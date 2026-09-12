import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { registerProject, suggestProjects } from '@main/projects/discovery'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function writeLog(claudeDir: string, slug: string, cwd: string, ageSeconds: number): void {
  const dir = join(claudeDir, slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, `${JSON.stringify({ type: 'user', cwd })}\n`)
  const when = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(file, when, when)
}

describe('suggestProjects', () => {
  it('returns the 10 most recently used folders, newest first', () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const root = mkdtempSync(join(tmpdir(), 'sugg-'))
    dirs.push(root)
    const claudeDir = join(root, 'claude-projects')

    for (let i = 0; i < 14; i++) {
      const cwd = join(root, `folder-${i}`)
      mkdirSync(cwd, { recursive: true })
      writeLog(claudeDir, `slug-${i}`, cwd, i * 60)
    }

    return suggestProjects(repos, claudeDir).then((suggestions) => {
      expect(suggestions).toHaveLength(10)
      expect(suggestions.map((s) => s.name)).toEqual(
        Array.from({ length: 10 }, (_, i) => `folder-${i}`),
      )
    })
  })

  it('skips folders already registered, filling the cap from older ones', async () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const root = mkdtempSync(join(tmpdir(), 'sugg-reg-'))
    dirs.push(root)
    const claudeDir = join(root, 'claude-projects')

    for (let i = 0; i < 12; i++) {
      const cwd = join(root, `folder-${i}`)
      mkdirSync(cwd, { recursive: true })
      writeLog(claudeDir, `slug-${i}`, cwd, i * 60)
    }
    registerProject(repos, { path: join(root, 'folder-0') })

    const names = (await suggestProjects(repos, claudeDir)).map((s) => s.name)
    expect(names).not.toContain('folder-0')
    expect(names).toEqual(Array.from({ length: 10 }, (_, i) => `folder-${i + 1}`))
  })
})
