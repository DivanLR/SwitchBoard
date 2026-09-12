import { describe, expect, it } from 'vitest'
import { DIAGRAM_PLAN_MARKER, parseDiagramPlan } from '@shared/diagram'

const line = (json: string): string => `Here is the plan.\n${DIAGRAM_PLAN_MARKER}: ${json}`

describe('parseDiagramPlan', () => {
  it('reads type, pattern, size and cuts', () => {
    const plan = parseDiagramPlan(
      line('{"type":"flow","pattern":"pipeline","size":"doc-wide","cuts":["retry paths"]}'),
    )
    expect(plan).toEqual({
      type: 'flow',
      pattern: 'pipeline',
      size: 'doc-wide',
      cuts: ['retry paths'],
    })
  })

  it('keeps a plan that names only some of the dials', () => {
    expect(parseDiagramPlan(line('{"type":"matrix"}'))).toEqual({
      type: 'matrix',
      pattern: null,
      size: null,
      cuts: [],
    })
  })

  it('treats an empty plan as no plan', () => {
    expect(parseDiagramPlan(line('{"type":"","pattern":null,"cuts":[]}'))).toBeNull()
  })

  it('reads the LAST marker, because the prompt names the sentinel', () => {
    const text = `${line('{"type":"first"}')}\n${line('{"type":"second"}')}`
    expect(parseDiagramPlan(text)?.type).toBe('second')
  })

  it('is null for text with no marker, and for a marker with broken JSON', () => {
    expect(parseDiagramPlan('drawing the auth flow now')).toBeNull()
    expect(parseDiagramPlan(line('{"type": "flow"'))).toBeNull()
  })

  it('stops at the end of the object, not the end of the message', () => {
    const plan = parseDiagramPlan(
      `${line('{"type":"flow","cuts":["error branches"]}')}\nNow drawing it. {not json}`,
    )
    expect(plan?.type).toBe('flow')
    expect(plan?.cuts).toEqual(['error branches'])
  })
})
