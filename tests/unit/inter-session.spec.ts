// The routing half of the cross-project handover tool (inter-session.ts). The
// two refusals are the ones that cost something real if they regress: a fuzzy
// match would send work to the wrong codebase, and a self-send would let a
// session queue itself work for ever.
import { describe, expect, it } from 'vitest'
import { handoff, type InterSessionDeps } from '@main/sessions/inter-session'

const deps = (from: string): { deps: InterSessionDeps; sent: { id: string; text: string }[] } => {
  const sent: { id: string; text: string }[] = []
  return {
    sent,
    deps: {
      from,
      projects: () => [
        { id: 'p1', name: 'Switchboard' },
        { id: 'p2', name: 'Ledger API' },
      ],
      enqueue: (id, text) => sent.push({ id, text }),
    },
  }
}

describe('handing work to another project', () => {
  it('queues for the named project, saying who asked', () => {
    const { deps: d, sent } = deps('Switchboard')
    const result = handoff(d, 'Ledger API', 'The auth header changed.')
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].id).toBe('p2')
    expect(sent[0].text).toContain('Handed over by the Switchboard session')
    expect(sent[0].text).toContain('The auth header changed.')
  })

  it('matches the name case-insensitively, since a model retypes it from memory', () => {
    const { deps: d, sent } = deps('Switchboard')
    expect(handoff(d, '  ledger api ', 'x').ok).toBe(true)
    expect(sent[0].id).toBe('p2')
  })

  it('delivers nothing for an unknown name, and lists what it could have meant', () => {
    const { deps: d, sent } = deps('Switchboard')
    const result = handoff(d, 'Ledger', 'x')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Switchboard, Ledger API')
    expect(sent).toHaveLength(0)
  })

  it('refuses the sender its own project, which would be a loop with no way out', () => {
    const { deps: d, sent } = deps('Switchboard')
    expect(handoff(d, 'Switchboard', 'x').ok).toBe(false)
    expect(sent).toHaveLength(0)
  })
})
