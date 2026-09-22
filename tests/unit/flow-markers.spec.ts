import { describe, expect, it } from 'vitest'
import { flowMarkerBroken, parseFlowMarker } from '@main/flow/flow-markers'
import { featuresPrompt, publishPrompt, scopePrompt } from '@main/flow/flow-prompts'

function line(json: unknown): string {
  return `Here is the breakdown.\nSWB_FLOW: ${JSON.stringify(json)}`
}

describe('the scope marker', () => {
  it('reads the items, risks and what was left out', () => {
    const marker = parseFlowMarker(
      line({
        kind: 'scope',
        items: [
          {
            localId: 'cart-race',
            title: 'Version the cart state',
            body: 'Reconcile optimistic updates by version.',
            acceptance: ['Two fast adds keep both items'],
            estimate: 'm',
          },
        ],
        risks: ['The reducer is shared with checkout'],
        outOfScope: ['The pricing service'],
      }),
    )

    expect(marker?.kind).toBe('scope')
    if (marker?.kind !== 'scope') return
    expect(marker.items).toHaveLength(1)
    expect(marker.items[0].localId).toBe('cart-race')
    expect(marker.items[0].acceptance).toEqual(['Two fast adds keep both items'])
    expect(marker.risks).toEqual(['The reducer is shared with checkout'])
    expect(marker.outOfScope).toEqual(['The pricing service'])
  })

  it('gives an item without a localId a positional one rather than dropping it', () => {
    const marker = parseFlowMarker(line({ kind: 'scope', items: [{ title: 'Nameless' }] }))
    expect(marker?.kind).toBe('scope')
    if (marker?.kind !== 'scope') return
    expect(marker.items[0].localId).toBe('item-1')
    expect(marker.items[0].estimate).toBe('m')
  })

  it('refuses a scope marker with no usable item, so a run never advances on nothing', () => {
    expect(parseFlowMarker(line({ kind: 'scope', items: [] }))).toBeNull()
    expect(parseFlowMarker(line({ kind: 'scope', items: [{ body: 'no title' }] }))).toBeNull()
  })
})

describe('the published marker', () => {
  it('keeps only the records that name both a local id and a work item id', () => {
    const marker = parseFlowMarker(
      line({
        kind: 'published',
        created: [
          { localId: 'a', workItemId: 4711, url: 'https://dev.azure.com/x/_workitems/edit/4711' },
          { localId: 'b' },
        ],
        failed: [{ localId: 'c', why: 'the area path was rejected' }],
      }),
    )

    expect(marker?.kind).toBe('published')
    if (marker?.kind !== 'published') return
    expect(marker.created).toEqual([
      { localId: 'a', workItemId: '4711', url: 'https://dev.azure.com/x/_workitems/edit/4711' },
    ])
    expect(marker.failed).toEqual([{ localId: 'c', why: 'the area path was rejected' }])
  })
})

describe('the features marker', () => {
  it('coerces numeric ids and drops anything without a title', () => {
    const marker = parseFlowMarker(
      line({ kind: 'features', features: [{ id: 91, title: 'Checkout v2' }, { id: 92 }] }),
    )
    expect(marker?.kind).toBe('features')
    if (marker?.kind !== 'features') return
    expect(marker.features).toEqual([{ id: '91', title: 'Checkout v2', state: null, url: null }])
  })
})

describe('malformed hand-backs', () => {
  it('reads nothing when there is no marker at all', () => {
    expect(parseFlowMarker('I finished the breakdown.')).toBeNull()
    expect(flowMarkerBroken('I finished the breakdown.')).toBe(false)
  })

  it('reports a marker it cannot parse, rather than staying silent', () => {
    expect(parseFlowMarker('SWB_FLOW: {oops')).toBeNull()
    expect(flowMarkerBroken('SWB_FLOW: {oops')).toBe(true)
    expect(flowMarkerBroken('SWB_FLOW: {"kind":"nonsense"}')).toBe(true)
  })

  it('takes the last marker when a session printed more than one', () => {
    const text = [
      line({ kind: 'scope', items: [{ localId: 'first', title: 'First' }] }),
      line({ kind: 'scope', items: [{ localId: 'second', title: 'Second' }] }),
    ].join('\n')
    const marker = parseFlowMarker(text)
    if (marker?.kind !== 'scope') return
    expect(marker.items[0].localId).toBe('second')
  })
})

describe('the prompts', () => {
  it('tells the scoping session to change nothing and hand back a marker', () => {
    const prompt = scopePrompt({ featureId: '4711', featureTitle: 'Checkout v2' })
    expect(prompt).toContain('4711')
    expect(prompt).toContain('Create nothing in Azure DevOps')
    expect(prompt).toContain('SWB_FLOW:')
    expect(prompt).toContain('Do not call ExitPlanMode')
  })

  it('tells the publisher to look for existing children before creating duplicates', () => {
    const prompt = publishPrompt({
      run: {
        id: 'r1',
        projectId: 'p1',
        featureId: '4711',
        featureTitle: 'Checkout v2',
        status: 'publishing',
        sessionId: 's1',
        risks: [],
        outOfScope: [],
        concurrency: 4,
        baseBranch: null,
        worktreeRoot: null,
        crosscheckRound: 0,
        concerns: [],
        specSessionId: null,
        note: null,
        startedAt: '2026-09-17T00:00:00.000Z',
        finishedAt: null,
      },
      items: [
        {
          id: 'i1',
          runId: 'r1',
          projectId: 'p1',
          position: 0,
          localId: 'cart-race',
          title: 'Version the cart state',
          body: 'Reconcile by version.',
          acceptance: ['Two fast adds keep both items'],
          estimate: 'm',
          workItemId: null,
          workItemUrl: null,
          branch: null,
          worktreePath: null,
          sessionId: null,
          status: 'proposed',
          attempts: 0,
          prId: null,
          prUrl: null,
          note: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
    })

    expect(prompt).toContain('list the existing children')
    expect(prompt).toContain('cart-race')
    expect(prompt).toContain('Report only ids Azure DevOps actually returned to you.')
  })

  it('keeps the feature search read-only', () => {
    const prompt = featuresPrompt('checkout')
    expect(prompt).toContain('checkout')
    expect(prompt).toContain('Read only: create nothing, update nothing.')
  })
})
