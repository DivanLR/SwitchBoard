import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  importSkills,
  isUsableSkillName,
  parseSkillFrontmatter,
  parseSkillSource,
} from '@main/skills/import'
import { reconcileSkills } from '@main/skills/install'
import { readSkillSource } from '@shared/skill-source'

describe('parseSkillSource', () => {
  it('reads the folder URL a developer actually pastes', () => {
    expect(parseSkillSource('https://github.com/mattpocock/skills/tree/main/skills/engineering')).toEqual({
      owner: 'mattpocock',
      repo: 'skills',
      ref: 'main',
      path: 'skills/engineering',
    })
  })

  it('reads a bare repository, leaving the ref for the default branch', () => {
    expect(parseSkillSource('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
      ref: null,
      path: '',
    })
    expect(parseSkillSource('https://github.com/owner/repo.git')).toMatchObject({ repo: 'repo' })
  })

  it('refuses anything that is not a github.com https URL', () => {
    for (const bad of [
      'notaurl',
      'http://github.com/owner/repo',
      'https://gitlab.com/owner/repo',
      'https://github.com.evil.test/owner/repo',
      'https://github.com/owner',
      'file:///etc/passwd',
    ]) {
      expect(() => parseSkillSource(bad), bad).toThrow()
    }
  })

  it('never yields a path that could climb out of where it is written', () => {
    for (const input of [
      'https://github.com/o/r/tree/../../etc/x',
      'https://github.com/o/r/tree/main/../../../etc',
      'https://github.com/o/r/tree/main/skills/../../../../etc',
    ]) {
      let path: string
      try {
        path = parseSkillSource(input).path
      } catch {
        continue 
      }
      expect(path.split('/'), input).not.toContain('..')
      expect(path.startsWith('/'), input).toBe(false)
    }
  })

  it('normalises an encoded traversal away too, rather than passing it through', () => {
    expect(parseSkillSource('https://github.com/o/r/tree/main/%2e%2e/x').path).toBe('')
  })
})

describe('parseSkillFrontmatter', () => {
  it('reads the name and description a SKILL.md declares', () => {
    const text = ['---', 'name: my-skill', 'description: Does a thing.', '---', '', '# Body'].join('\n')
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'my-skill', description: 'Does a thing.' })
  })

  it('survives CRLF, quotes, and a leading byte-order mark', () => {
    const text = '﻿---\r\nname: "my-skill"\r\ndescription: \'Quoted.\'\r\n---\r\n'
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'my-skill', description: 'Quoted.' })
  })

  it('answers null when there is no name to key the skill on', () => {
    expect(parseSkillFrontmatter('# Just a heading')).toBeNull()
    expect(parseSkillFrontmatter('---\ndescription: no name\n---')).toBeNull()
  })

  it('keeps a description that is simply absent, rather than refusing the skill', () => {
    expect(parseSkillFrontmatter('---\nname: bare\n---')).toEqual({ name: 'bare', description: '' })
  })
})

describe('isUsableSkillName', () => {
  it('accepts the lower-case dashed form skills actually use', () => {
    expect(isUsableSkillName('code-review')).toBe(true)
    expect(isUsableSkillName('a')).toBe(true)
  })

  it('refuses anything that could escape a directory or break a command', () => {
    for (const bad of ['../evil', 'Has Spaces', 'UPPER', '-leading', 'trailing/', '', 'a'.repeat(64)]) {
      expect(isUsableSkillName(bad), bad).toBe(false)
    }
  })
})

describe('readSkillSource', () => {
  it('answers with the parts, not an exception, for a URL it accepts', () => {
    const result = readSkillSource('https://github.com/owner/repo/tree/next/skills/a')

    expect(result.ok).toBe(true)
    expect(result.ok && result.source).toEqual({ owner: 'owner', repo: 'repo', ref: 'next', path: 'skills/a' })
  })

  it('answers with the reason, not an exception, for one it refuses', () => {
    const result = readSkillSource('https://gitlab.com/owner/repo')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('github.com')
  })

  it('agrees with the throwing face on every input', () => {
    const inputs = [
      'https://github.com/owner/repo',
      'https://github.com/owner/repo.git',
      'https://github.com/owner/repo/tree/main/skills',
      'https://github.com/owner/repo/issues/4',
      'https://gitlab.com/owner/repo',
      'not a url',
      'https://github.com/owner',
      'https://github.com/o/r/tree/main/../x',
    ]
    for (const input of inputs) {
      const shared = readSkillSource(input)
      let threw = false
      try {
        parseSkillSource(input)
      } catch {
        threw = true
      }
      expect(threw, input).toBe(!shared.ok)
    }
  })
})

describe('importSkills download policy', () => {
  const SOURCE = 'https://github.com/tt-a1i/archify/tree/main/archify'
  const TREE = {
    tree: [
      { path: 'archify/SKILL.md', type: 'blob', size: 64 },
      { path: 'archify/bin/archify.mjs', type: 'blob', size: 64 },
    ],
  }
  const MANIFEST = '---\nname: archify\ndescription: Draws architecture.\n---\n'

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubGitHub(bin: (attempt: number) => Response): string[] {
    const calls: string[] = []
    let attempt = 0
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(TREE))
      if (url.endsWith('SKILL.md')) return new Response(MANIFEST)
      attempt += 1
      return bin(attempt)
    })
    return calls
  }

  it('retries a blip rather than losing an import that had almost landed', async () => {
    const calls = stubGitHub((attempt) =>
      attempt === 1 ? new Response('', { status: 400 }) : new Response('export const x = 1\n'),
    )
    const root = await mkdtemp(join(tmpdir(), 'sb-skills-'))
    try {
      const result = await importSkills(SOURCE, root, new Set())
      expect(result.imported).toMatchObject([{ name: 'archify', fileCount: 2 }])
      expect(await readFile(join(root, 'archify', 'bin', 'archify.mjs'), 'utf8')).toContain('export const x')
      expect(calls.filter((url) => url.endsWith('archify.mjs'))).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('asks once for a 404, which is an answer and not a blip', async () => {
    const calls = stubGitHub(() => new Response('', { status: 404 }))
    const root = await mkdtemp(join(tmpdir(), 'sb-skills-'))
    try {
      await expect(importSkills(SOURCE, root, new Set())).rejects.toMatchObject({
        message: 'Could not read archify/bin/archify.mjs (404).',
      })
      expect(calls.filter((url) => url.endsWith('archify.mjs'))).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves an oversized asset behind instead of losing the whole skill', async () => {
    TREE.tree.push({ path: 'archify/assets/music.mp3', type: 'blob', size: 20 * 1024 * 1024 })
    const calls = stubGitHub(() => new Response('export const x = 1\n'))
    const root = await mkdtemp(join(tmpdir(), 'sb-skills-'))
    try {
      const result = await importSkills(SOURCE, root, new Set())
      expect(result.imported).toMatchObject([{ name: 'archify', fileCount: 2 }])
      expect(result.skipped).toMatchObject([{ name: 'archify/assets/music.mp3' }])
      expect(calls.some((url) => url.endsWith('music.mp3'))).toBe(false)
    } finally {
      TREE.tree.pop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('importSkills folder layout', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sb-skills-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  })

  function stubTree(paths: string[], body: (path: string) => Response): void {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ tree: paths.map((path) => ({ path, type: 'blob', size: 64 })) }))
      }
      return body(decodeURIComponent(url.split('/main/')[1] ?? ''))
    })
  }

  const manifest = (name: string) => new Response(`---\nname: ${name}\ndescription: x\n---\n`)

  it('imports a repository whose root is the skill with every file name and subfolder intact', async () => {
    stubTree(['SKILL.md', 'README.md', 'bin/tool.mjs'], (path) =>
      path === 'SKILL.md' ? manifest('myskill') : new Response(`content of ${path}`),
    )

    const result = await importSkills('https://github.com/someone/myskill/tree/main', root, new Set())

    expect(result.imported).toMatchObject([{ name: 'myskill', sourcePath: '', fileCount: 3 }])
    expect((await readdir(join(root, 'myskill'))).sort()).toEqual(['README.md', 'SKILL.md', 'bin'])
    expect(await readFile(join(root, 'myskill', 'bin', 'tool.mjs'), 'utf8')).toBe('content of bin/tool.mjs')
  })

  it('takes the first of two skills that share a name and says why it skipped the second', async () => {
    stubTree(['skills/a/SKILL.md', 'skills/a/only-in-a.md', 'legacy/a/SKILL.md'], (path) =>
      path.endsWith('SKILL.md') ? manifest('dup') : new Response('a'),
    )

    const result = await importSkills('https://github.com/someone/skills/tree/main', root, new Set())

    expect(result.imported).toMatchObject([{ name: 'dup', sourcePath: 'skills/a' }])
    expect(result.skipped).toEqual([{ name: 'dup', reason: 'Another skill in this import already has that name.' }])
    expect((await readdir(join(root, 'dup'))).sort()).toEqual(['SKILL.md', 'only-in-a.md'])
  })

  it('keeps the staged copy of a skill when a re-import of it fails part way', async () => {
    await mkdir(join(root, 'research'), { recursive: true })
    await writeFile(join(root, 'research', 'SKILL.md'), 'the copy that works')
    stubTree(['research/SKILL.md', 'research/big.md'], (path) =>
      path.endsWith('SKILL.md') ? manifest('research') : new Response('', { status: 404 }),
    )

    await expect(
      importSkills('https://github.com/someone/skills/tree/main', root, new Set()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect(await readFile(join(root, 'research', 'SKILL.md'), 'utf8')).toBe('the copy that works')
    expect(await readdir(root)).toEqual(['research'])
  })
})

describe('reconcileSkills at startup', () => {
  let home: string
  let staging: string
  const previous = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sb-home-'))
    staging = join(home, 'staging')
    process.env.USERPROFILE = home
    process.env.HOME = home
    for (const name of ['tdd', 'missing', 'off']) {
      await mkdir(join(staging, name), { recursive: true })
      await writeFile(join(staging, name, 'SKILL.md'), `staged ${name}`)
    }
  })

  afterEach(async () => {
    process.env.USERPROFILE = previous.USERPROFILE
    process.env.HOME = previous.HOME
    await rm(home, { recursive: true, force: true })
  })

  it('restores only a missing skill, and leaves a live folder a person edited or owns alone', async () => {
    const live = join(home, '.claude', 'skills')
    await mkdir(join(live, 'tdd'), { recursive: true })
    await writeFile(join(live, 'tdd', 'SKILL.md'), 'edited for my team')
    await mkdir(join(live, 'off'), { recursive: true })
    await writeFile(join(live, 'off', 'SKILL.md'), 'my own skill of that name')

    await reconcileSkills(staging, [
      { name: 'tdd', enabled: true },
      { name: 'missing', enabled: true },
      { name: 'off', enabled: false },
    ])

    expect(await readFile(join(live, 'tdd', 'SKILL.md'), 'utf8')).toBe('edited for my team')
    expect(await readFile(join(live, 'missing', 'SKILL.md'), 'utf8')).toBe('staged missing')
    expect(await readFile(join(live, 'off', 'SKILL.md'), 'utf8')).toBe('my own skill of that name')
  })
})
