// The archify engine's pure rules in src/shared/diagram.ts — the second way the
// Diagrams section draws. Same conventions as diagrams.spec.ts: these are the
// facts main, renderer and the e2e mock host all have to agree on, so they are
// tested without a database and without a session.
//
// The prompt is asserted on its GUARANTEES rather than its wording. A test that
// pinned the whole paragraph would fail on every edit and teach the next person
// to update the expectation without reading it. What actually matters is that
// the file lands where the section looks, that the chosen type is honoured, and
// that the two rules a background session cannot recover from are present.
import { describe, expect, it } from 'vitest'
import {
  ARCHIFY,
  ARCHIFY_COMMANDS,
  ARCHIFY_TYPES,
  DEFAULT_ARCHIFY,
  DIAGRAMS_DIR,
  archifyCommandText,
  archifyPrompt,
  archifySpecFile,
  type ArchifyOptions,
} from '@shared/diagram'

const options = (patch: Partial<ArchifyOptions> = {}): ArchifyOptions => ({
  ...DEFAULT_ARCHIFY,
  ...patch,
})

describe('archifySpecFile', () => {
  it('names the specification beside the diagram, the way archify names its own', () => {
    expect(archifySpecFile('auth-flow.html', 'sequence')).toBe('auth-flow.sequence.json')
  })

  it('leaves the type as a placeholder when the session is choosing it', () => {
    expect(archifySpecFile('auth-flow.html', 'auto')).toBe('auth-flow.<type>.json')
  })
})

describe('archifyPrompt', () => {
  it('delivers into the one folder the section lists', () => {
    const prompt = archifyPrompt('the auth flow', 'auth-flow.html', options())
    expect(prompt).toContain(`${DIAGRAMS_DIR}/auth-flow.html`)
    // The reply line is how the session says it is done, and the section reads
    // the folder rather than the reply — but a prompt that asked for a file
    // somewhere else would strand the drawing, so the path appears in both.
    expect(prompt).toContain(`wrote ${DIAGRAMS_DIR}/auth-flow.html`)
  })

  it('names the chosen type and forbids substituting another', () => {
    const prompt = archifyPrompt('a request lifecycle', 'req.html', options({ type: 'sequence' }))
    expect(prompt).toContain('Use the sequence type. Do not substitute another one.')
    expect(prompt).toContain(`validate sequence ${DIAGRAMS_DIR}/req.sequence.json`)
    // With a type chosen there is nothing to ask `guide` about.
    expect(prompt).not.toContain('guide "')
  })

  it('asks archify itself which type fits when the developer did not choose', () => {
    const prompt = archifyPrompt('something vague', 'vague.html', options({ type: 'auto' }))
    expect(prompt).toContain('guide "something vague" --json')
    expect(prompt).toContain('Choose the type yourself')
  })

  it('never lets a quoted description break out of the guide command', () => {
    // The description lands inside a double-quoted shell argument in the prompt.
    // One unescaped quote in it would end that argument and change the command.
    const prompt = archifyPrompt('the "auth" flow', 'auth.html', options({ type: 'auto' }))
    const line = prompt.split('\n').find((l) => l.includes('guide '))
    expect(line).toBeDefined()
    // Exactly two quotes on that line: the ones this code put there.
    expect(line!.split('"')).toHaveLength(3)
    expect(line).toContain("guide \"the 'auth' flow\" --json")
  })

  it('carries the quality profile into both the file and the flags', () => {
    const showcase = archifyPrompt('x', 'x.html', options({ quality: 'showcase' }))
    expect(showcase).toContain('--quality showcase')
    expect(showcase).toContain('meta.quality_profile to "showcase"')
    // The showcase acceptance bar, which is the reason to pick it at all.
    expect(showcase).toContain('all 9 artifact checks')

    const standard = archifyPrompt('x', 'x.html', options({ quality: 'standard' }))
    expect(standard).toContain('--quality standard')
    expect(standard).toContain('meta.quality_profile to "standard"')
    expect(standard).not.toContain('all 9 artifact checks')
  })

  it('turns the viewer extras on only when they were asked for', () => {
    const still = archifyPrompt('x', 'x.html', options({ motion: false }))
    expect(still).toContain('Leave motion off')
    expect(still).not.toContain('meta.animation to "trace"')

    const moving = archifyPrompt('x', 'x.html', options({ motion: true }))
    expect(moving).toContain('meta.animation to "trace"')
    expect(moving).not.toContain('Leave motion off')
  })

  it('refuses preview, which would hold a background session open for ever', () => {
    // The one rule that cannot be recovered from. `archify preview` watches a
    // file on a loopback port and returns only on Ctrl-C; nobody is at the
    // keyboard of a background drawing session, so a preview would keep it alive
    // until something killed it and the section would show "drawing…" until its
    // own twenty-minute deadline expired and then blame the deadline.
    for (const type of ARCHIFY_TYPES) {
      const prompt = archifyPrompt('x', 'x.html', options({ type: type.type }))
      expect(prompt).toContain('NEVER run `archify preview`')
    }
  })

  it('states that a non-zero exit is a failure, because a failed deliver keeps the old file', () => {
    const prompt = archifyPrompt('x', 'x.html', options())
    expect(prompt).toContain('non-zero exit is a failure')
    // Why it matters, and why the app cannot catch this itself: the section only
    // ever sees a folder listing, and a stale file looks exactly like a fresh one.
    expect(prompt).toContain('leaves the previous output in place')
  })

  it('prints the same plan line the other engine does, so one strip reads both', () => {
    const prompt = archifyPrompt('x', 'x.html', options({ quality: 'showcase' }))
    expect(prompt).toContain('SWB_DIAGRAM:')
    expect(prompt).toContain('"size": "showcase"')
  })
})

describe('archifyCommandText', () => {
  it('runs what was typed, through the skill’s own bin', () => {
    const text = archifyCommandText('archify doctor')
    expect(text).toContain(`node ${ARCHIFY.bin} doctor`)
    // The prefix is the marker, not part of the command: sending `archify
    // archify doctor` would be a usage error.
    expect(text).not.toContain('archify.mjs archify')
  })

  it('tolerates the prefix being absent or oddly spaced', () => {
    expect(archifyCommandText('validate workflow spec.json')).toContain(
      `node ${ARCHIFY.bin} validate workflow spec.json`,
    )
    expect(archifyCommandText('  ARCHIFY   guide  ')).toContain(`node ${ARCHIFY.bin} guide`)
  })

  it('sends every command to the folder this section lists', () => {
    expect(archifyCommandText('archify demo')).toContain(DIAGRAMS_DIR)
  })
})

describe('ARCHIFY_COMMANDS', () => {
  it('marks preview, and only preview, as one that must not be dispatched', () => {
    const inert = ARCHIFY_COMMANDS.filter((c) => !c.sendable).map((c) => c.command)
    expect(inert).toEqual(['preview'])
  })

  it('carries archify’s whole CLI, so the menu says what the tool can do', () => {
    const names = ARCHIFY_COMMANDS.map((c) => c.command)
    // Every subcommand archify's own usage() prints.
    for (const expected of [
      'render',
      'compare',
      'deliver',
      'preview',
      'validate',
      'migrate',
      'inspect',
      'check',
      'visual-check',
      'guide',
      'brands',
      'examples',
      'doctor',
      'demo',
    ]) {
      expect(names).toContain(expected)
    }
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('ARCHIFY_TYPES', () => {
  it('offers archify’s five types plus letting it choose', () => {
    expect(ARCHIFY_TYPES.map((t) => t.type)).toEqual([
      'auto',
      'architecture',
      'workflow',
      'sequence',
      'dataflow',
      'lifecycle',
    ])
  })

  it('starts on auto, showcase and still, which are the skill’s own defaults', () => {
    expect(DEFAULT_ARCHIFY).toEqual({ type: 'auto', quality: 'showcase', motion: false })
  })
})
