// The parsing and safety rules of the custom-skill importer.
//
// These are the parts that decide what a URL is allowed to mean and what a
// remote repository is allowed to write, so they are tested directly rather than
// through a network call. The download path itself is not mocked out and
// re-tested here: it is fetch plus writeFile, and a test of that shape only
// asserts that Node works.
import { describe, expect, it } from 'vitest'
import {
  isUsableSkillName,
  parseSkillFrontmatter,
  parseSkillSource,
} from '@main/skills/import'
import { readSkillSource } from '@shared/skill-source'

describe('parseSkillSource', () => {
  it('reads the folder URL a developer actually pastes', () => {
    // The exact shape GitHub's "browse a folder" address bar produces, which is
    // what the owner asked to be able to paste.
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

  // Every one of these reaches a URL that this app would then fetch, so each is
  // refused before a request rather than sanitised into something plausible.
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

  // The guarantee is that no traversal segment ever reaches the parsed path, not
  // that every such URL throws. `new URL()` resolves `..` out of the pathname
  // before this function sees it, so one of these lands on a different but
  // well-formed repository reference and the other stops being a /tree/ URL at
  // all. Both outcomes are safe; asserting "throws" would have been asserting the
  // wrong thing, and would break the moment URL parsing changed.
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
        continue // refused outright, which is also fine
      }
      expect(path.split('/'), input).not.toContain('..')
      expect(path.startsWith('/'), input).toBe(false)
    }
  })

  // Percent-encoded traversal is normalised away by URL parsing as well, which
  // is worth pinning because it is not obvious: `%2e%2e` is decoded and resolved
  // as `..` rather than surviving as a literal folder name. Recorded so that a
  // future change away from `new URL()` cannot quietly remove the protection
  // nobody realised was coming from there.
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
    // All three turn up in files written on Windows or by an editor that adds a
    // BOM, and a skill that fails to import for one of them looks like a bug in
    // the repository rather than in this parser.
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
  // The name becomes a directory under ~/.claude/skills AND the slash command,
  // so it has to be safe as both.
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

// The renderer-facing face of the same parser. The Settings field applies these
// rules as the URL is typed, so it needs a verdict it can render rather than an
// exception — and the two faces must never disagree, which is why they are one
// implementation with a throwing wrapper over it.
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
    // The whole point of sharing the implementation. If these two ever diverge,
    // the field would arm a button for a URL the importer then refuses.
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
