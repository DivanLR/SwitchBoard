import { describe, expect, it } from 'vitest'
import { allowedPullRequestUrl, flowMarkerBroken, parseFlowMarker } from '@main/flow/flow-markers'
import { clarifyPrompt, featuresPrompt, planSteps, specifyPrompt } from '@main/flow/flow-prompts'

function line(json: unknown): string {
  return `Here is my report.\nSWB_FLOW: ${JSON.stringify(json)}`
}

describe('the stage marker', () => {
  it('reads a plain done outcome', () => {
    const marker = parseFlowMarker(
      line({
        kind: 'stage',
        stage: 'plan',
        outcome: 'done',
        summary: 'Wrote plan.md and tasks.md.',
      }),
    )
    expect(marker?.kind).toBe('stage')
    if (marker?.kind !== 'stage') return
    expect(marker.stage).toBe('plan')
    expect(marker.outcome).toBe('done')
    expect(marker.summary).toBe('Wrote plan.md and tasks.md.')
    expect(marker.why).toBeNull()
  })

  it('refuses an unknown stage or outcome, so a run never advances on nothing', () => {
    expect(parseFlowMarker(line({ kind: 'stage', stage: 'nonsense', outcome: 'done' }))).toBeNull()
    expect(parseFlowMarker(line({ kind: 'stage', stage: 'spec', outcome: 'maybe' }))).toBeNull()
  })

  it('reads a blocked outcome with why', () => {
    const marker = parseFlowMarker(
      line({
        kind: 'stage',
        stage: 'build',
        outcome: 'blocked',
        summary: '',
        why: 'the API key is missing',
      }),
    )
    expect(marker?.kind).toBe('stage')
    if (marker?.kind !== 'stage') return
    expect(marker.outcome).toBe('blocked')
    expect(marker.why).toBe('the API key is missing')
  })

  it('reads the spec extras', () => {
    const marker = parseFlowMarker(
      line({
        kind: 'stage',
        stage: 'spec',
        outcome: 'done',
        summary: 'ok',
        specDir: 'specs/003-checkout',
      }),
    )
    if (marker?.kind !== 'stage') throw new Error('expected a stage marker')
    expect(marker.specDir).toBe('specs/003-checkout')
  })

  it('reads the review extras and keeps only known severities', () => {
    const marker = parseFlowMarker(
      line({
        kind: 'stage',
        stage: 'review',
        outcome: 'done',
        summary: 'reviewed',
        verdict: 'needs_fixes',
        findings: [
          { severity: 'must_fix', file: 'Cart.cs', line: 42, what: 'no null check' },
          { severity: 'nonsense', file: null, line: null, what: 'defaults to should_fix' },
        ],
        unmet: ['Two fast adds keep both items'],
      }),
    )
    if (marker?.kind !== 'stage') throw new Error('expected a stage marker')
    expect(marker.verdict).toBe('needs_fixes')
    expect(marker.findings).toEqual([
      { severity: 'must_fix', file: 'Cart.cs', line: 42, what: 'no null check' },
      { severity: 'should_fix', file: null, line: null, what: 'defaults to should_fix' },
    ])
    expect(marker.unmet).toEqual(['Two fast adds keep both items'])
  })

  it('reads the ship extras', () => {
    const marker = parseFlowMarker(
      line({
        kind: 'stage',
        stage: 'ship',
        outcome: 'done',
        summary: 'pushed',
        prUrl: 'https://x/pr/9',
        prId: '9',
      }),
    )
    if (marker?.kind !== 'stage') throw new Error('expected a stage marker')
    expect(marker.prUrl).toBe('https://x/pr/9')
    expect(marker.prId).toBe('9')
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
    expect(parseFlowMarker('I finished the work.')).toBeNull()
    expect(flowMarkerBroken('I finished the work.')).toBe(false)
  })

  it('reports a marker it cannot parse, rather than staying silent', () => {
    expect(parseFlowMarker('SWB_FLOW: {oops')).toBeNull()
    expect(flowMarkerBroken('SWB_FLOW: {oops')).toBe(true)
    expect(flowMarkerBroken('SWB_FLOW: {"kind":"nonsense"}')).toBe(true)
  })

  it('takes the last marker when a session printed more than one', () => {
    const text = [
      line({ kind: 'stage', stage: 'spec', outcome: 'done', summary: 'first' }),
      line({ kind: 'stage', stage: 'spec', outcome: 'done', summary: 'second' }),
    ].join('\n')
    const marker = parseFlowMarker(text)
    if (marker?.kind !== 'stage') return
    expect(marker.summary).toBe('second')
  })
})

describe('the pull request link a ship marker reports', () => {
  it('is kept only as https on GitHub, Azure DevOps or the origin host, without credentials', () => {
    expect(allowedPullRequestUrl('https://github.com/o/r/pull/7', null)).toBe(
      'https://github.com/o/r/pull/7',
    )
    expect(
      allowedPullRequestUrl('https://dev.azure.com/o/p/_git/r/pullrequest/9', null),
    ).not.toBeNull()
    expect(
      allowedPullRequestUrl('https://contoso.visualstudio.com/p/_git/r/pullrequest/9', null),
    ).not.toBeNull()
    expect(
      allowedPullRequestUrl('https://git.corp.example/o/r/pulls/3', 'git.corp.example'),
    ).not.toBeNull()
    expect(allowedPullRequestUrl('https://git.corp.example/o/r/pulls/3', null)).toBeNull()
    expect(allowedPullRequestUrl('http://github.com/o/r/pull/7', null)).toBeNull()
    expect(allowedPullRequestUrl('https://token@github.com/o/r/pull/7', null)).toBeNull()
    expect(allowedPullRequestUrl('https://github.com.evil.example/o/r/pull/7', null)).toBeNull()
    expect(allowedPullRequestUrl('javascript:alert(1)', null)).toBeNull()
    expect(allowedPullRequestUrl(null, null)).toBeNull()
  })
})

describe('the prompts', () => {
  it('keeps the feature search read-only', () => {
    const prompt = featuresPrompt('checkout')
    expect(prompt).toContain('checkout')
    expect(prompt).toContain('Read only: create nothing, update nothing.')
    expect(prompt).toContain('SWB_FLOW:')
  })

  it('starts an ADO spec step with the slash command and carries the ado rule in its argument', () => {
    const prompt = specifyPrompt({
      source: 'ado',
      sourceRef: '4711',
      sourceUrl: 'https://dev.azure.com/x/_workitems/edit/4711',
      title: 'Checkout v2',
      description: '',
      autopilot: false,
    })
    expect(prompt.startsWith('/speckit-specify Azure DevOps Feature 4711: Checkout v2')).toBe(true)
    expect(prompt).toContain('Azure DevOps MCP server')
    expect(prompt).toContain('https://dev.azure.com/x/_workitems/edit/4711')
  })

  it('asks the human through AskUserQuestion without autopilot, and answers itself with it', () => {
    const run = {
      source: 'text' as const,
      sourceRef: null,
      sourceUrl: null,
      title: 'Checkout v2',
      description: 'Let a guest pay without an account.',
    }
    const manual = specifyPrompt({ ...run, autopilot: false })
    expect(
      manual.startsWith('/speckit-specify Checkout v2: Let a guest pay without an account.'),
    ).toBe(true)
    expect(manual).toContain('AskUserQuestion')
    expect(clarifyPrompt(false).startsWith('/speckit-clarify ')).toBe(true)
    expect(clarifyPrompt(false)).toContain('AskUserQuestion')

    const auto = specifyPrompt({ ...run, autopilot: true })
    expect(auto).not.toContain('AskUserQuestion')
    expect(auto).toContain('Answer each question yourself with your recommended option')
    expect(clarifyPrompt(true)).toContain(
      'Answer each question yourself with your recommended option',
    )
  })

  it('mentions only the stacks the run actually detected', () => {
    expect(planSteps(['dotnet'], null)[0]).toContain('.NET:')
    expect(planSteps(['dotnet'], null)[0]).not.toContain('Angular:')
    expect(planSteps(['angular'], null)[0]).toContain('Angular:')
    expect(planSteps(['angular'], null)[0]).not.toContain('.NET:')
    const both = planSteps(['dotnet', 'angular'], null)[0]
    expect(both).toContain('.NET:')
    expect(both).toContain('Angular:')
  })
})
