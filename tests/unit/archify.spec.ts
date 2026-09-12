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

  it('names every type concretely, with no placeholder left to substitute', () => {
    for (const t of ARCHIFY_TYPES) {
      expect(archifySpecFile('auth-flow.html', t.type)).toBe(`auth-flow.${t.type}.json`)
    }
  })
})

describe('archifyPrompt', () => {
  it('delivers into the one folder the section lists', () => {
    const prompt = archifyPrompt('the auth flow', 'auth-flow.html', options())
    expect(prompt).toContain(`${DIAGRAMS_DIR}/auth-flow.html`)
    expect(prompt).toContain(`wrote ${DIAGRAMS_DIR}/auth-flow.html`)
  })

  it('names the chosen type and forbids substituting another', () => {
    const prompt = archifyPrompt('a request lifecycle', 'req.html', options({ type: 'sequence' }))
    expect(prompt).toContain('Use the sequence type. Do not substitute another one.')
    expect(prompt).toContain(`validate sequence ${DIAGRAMS_DIR}/req.sequence.json`)
    expect(prompt).not.toContain('guide "')
  })

  it('never asks archify which type to use, because the developer always has', () => {
    for (const t of ARCHIFY_TYPES) {
      const prompt = archifyPrompt('the "auth" flow', 'auth.html', options({ type: t.type }))
      expect(prompt).not.toContain('guide ')
      expect(prompt).not.toContain('Choose the type yourself')
      expect(prompt).toContain(`Use the ${t.type} type`)
    }
  })

  it('carries the quality profile into both the file and the flags', () => {
    const showcase = archifyPrompt('x', 'x.html', options({ quality: 'showcase' }))
    expect(showcase).toContain('--quality showcase')
    expect(showcase).toContain('meta.quality_profile to "showcase"')
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
    for (const type of ARCHIFY_TYPES) {
      const prompt = archifyPrompt('x', 'x.html', options({ type: type.type }))
      expect(prompt).toContain('NEVER run `archify preview`')
    }
  })

  it('states that a non-zero exit is a failure, because a failed deliver keeps the old file', () => {
    const prompt = archifyPrompt('x', 'x.html', options())
    expect(prompt).toContain('non-zero exit is a failure')
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
  it('offers archify’s five types, all concrete', () => {
    expect(ARCHIFY_TYPES.map((t) => t.type)).toEqual([
      'architecture',
      'workflow',
      'sequence',
      'dataflow',
      'lifecycle',
    ])
  })

  it('starts on architecture, showcase and still', () => {
    expect(DEFAULT_ARCHIFY).toEqual({ type: 'architecture', quality: 'showcase', motion: false })
  })

  it('defaults to a type that is in the offered list', () => {
    expect(ARCHIFY_TYPES.map((t) => t.type)).toContain(DEFAULT_ARCHIFY.type)
  })

  it('starts with no reference file, because most diagrams are described', () => {
    expect(DEFAULT_ARCHIFY.reference).toBeUndefined()
  })
})

describe('archifyPrompt with a reference file', () => {
  const options = { ...DEFAULT_ARCHIFY, reference: 'C:\\Users\\d\\Desktop\\arch.drawio' }

  it('carries the path, quoted, so a folder with a space survives', () => {
    const prompt = archifyPrompt('the auth flow', 'auth-flow.html', {
      ...options,
      reference: 'C:\\my diagrams\\arch.drawio',
    })
    expect(prompt).toContain('"C:\\my diagrams\\arch.drawio"')
  })

  it('names the reference before any authoring instruction', () => {
    const prompt = archifyPrompt('the auth flow', 'auth-flow.html', options)
    expect(prompt.indexOf('arch.drawio')).toBeLessThan(prompt.indexOf('fast authoring path'))
  })

  it('tells the skill to carry the file over rather than invent from the sentence', () => {
    const prompt = archifyPrompt('the auth flow', 'auth-flow.html', options)
    expect(prompt).toMatch(/read it first/i)
    expect(prompt).toMatch(/cannot be read/i)
  })

  it('says nothing about a reference when there is none', () => {
    const prompt = archifyPrompt('the auth flow', 'auth-flow.html', DEFAULT_ARCHIFY)
    expect(prompt).not.toMatch(/reference/i)
    expect(prompt).not.toMatch(/read it first/i)
  })

  it('still honours the type, quality and motion switches', () => {
    const prompt = archifyPrompt('the auth flow', 'auth-flow.html', {
      ...options,
      type: 'sequence',
      quality: 'standard',
      motion: true,
    })
    expect(prompt).toContain('sequence')
    expect(prompt).toContain('standard')
    expect(prompt).toContain('arch.drawio')
  })
})
