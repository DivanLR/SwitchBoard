// The diagram-design skill states what it is about to draw — visual type, semantic
// pattern, size preset, and what the complexity budget forced out — and then draws.
// That sentence says what the picture was TRYING to be, which is what the Diagrams
// section needs in order to be judged, and it used to scroll past in the transcript.
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

  // A skill version that announces nothing must not leave an empty strip above
  // every diagram: no facts is no plan.
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

  // Prose after the object is normal: the model keeps talking. Brace matching has
  // to stop at the object's own close rather than the last brace in the message.
  it('stops at the end of the object, not the end of the message', () => {
    const plan = parseDiagramPlan(
      `${line('{"type":"flow","cuts":["error branches"]}')}\nNow drawing it. {not json}`,
    )
    expect(plan?.type).toBe('flow')
    expect(plan?.cuts).toEqual(['error branches'])
  })
})
