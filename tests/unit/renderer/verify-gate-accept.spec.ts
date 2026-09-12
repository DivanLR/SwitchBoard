import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useVerifyGates } from '@renderer/composables/useVerifyGates'
import type { VerifyReport, VerifyRun } from '@shared/domain'

const measured = (value: number) => ({ value, source: 'a real runner' })
const absent = { value: null, source: null }

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    suites: [],
    coverage: { line: absent, changed: absent, files: [] },
    quality: {
      gate: null,
      gateSource: null,
      duplication: absent,
      mutation: absent,
      mutationKilled: null,
      mutationSurvived: null,
      archViolations: absent,
      debt: null,
      findings: [],
    },
    endpoints: [],
    ...over,
  } as VerifyReport
}

function run(over: Partial<VerifyReport> = {}): VerifyRun {
  return {
    id: 'r1',
    projectId: 'p1',
    stackId: 'dotnet',
    sessionId: 's1',
    branch: 'main',
    requested: [],
    verdict: 'inconclusive',
    report: report(over),
    startedAt: '2026-08-21T00:00:00.000Z',
    finishedAt: '2026-08-21T00:01:00.000Z',
    error: null,
  } as unknown as VerifyRun
}

function gatesFor(latestRun: VerifyRun | null, ids: string[] = []) {
  const latest = ref(latestRun)
  const { gates, score } = useVerifyGates(
    computed(() => latest.value),
    computed(() => new Set(ids)),
  )
  return { gates: gates.value, score: score.value, byId: (id: string) => gates.value.find((g) => g.id === id)! }
}

describe('a gate nothing measured', () => {
  it('offers to be accepted', () => {
    expect(gatesFor(run()).byId('mutation').acceptable).toBe(true)
  })

  it('reads green once accepted, and says it was accepted rather than passed', () => {
    const gate = gatesFor(run(), ['mutation']).byId('mutation')

    expect(gate.status).toBe('pass')
    expect(gate.value).toBe('accepted')
    expect(gate.sub).toContain('you accepted this')
  })

  it('stays out of the counted score, exactly as an unmeasured gate does', () => {
    const before = gatesFor(run()).score
    const after = gatesFor(run(), ['mutation']).score

    expect(before).toBeNull()
    expect(after).toBeNull()
  })

  it('does not inflate the score of a run that did measure something', () => {
    const suites = [{ id: 'dotnet-unit', label: 'Unit tests', status: 'pass' as const, detail: '10 passed' }]
    const plain = gatesFor(run({ suites }))
    const withAccept = gatesFor(run({ suites }), ['mutation', 'coverage'])

    expect(plain.score?.measured).toBe(withAccept.score?.measured)
    expect(withAccept.score?.pct).toBe(plain.score?.pct)
  })
})

describe('a gate a run did measure', () => {
  it('offers no acceptance when the figure met its target', () => {
    const gate = gatesFor(run({ quality: { ...report().quality, mutation: measured(90) } })).byId('mutation')

    expect(gate.status).toBe('pass')
    expect(gate.acceptable).toBe(false)
  })

  it('offers no acceptance when the figure came UNDER target', () => {
    const under = run({ quality: { ...report().quality, mutation: measured(12) } })

    expect(gatesFor(under).byId('mutation').acceptable).toBe(false)
  })

  it('ignores an acceptance recorded for it, rather than honouring the stale one', () => {
    const under = run({ quality: { ...report().quality, mutation: measured(12) } })
    const gate = gatesFor(under, ['mutation']).byId('mutation')

    expect(gate.accepted).toBeFalsy()
    expect(gate.value).toBe('12%')
  })
})

describe('a suite that was skipped', () => {
  const skipped = run({ suites: [{ id: 'dotnet-unit', label: 'Unit tests', status: 'skipped' as const, detail: 'no runner here' }] })

  it('is a warning that can be accepted, since nothing measured it either', () => {
    const gate = gatesFor(skipped).byId('unit')

    expect(gate.status).toBe('warn')
    expect(gate.value).toBe('skipped')
    expect(gate.acceptable).toBe(true)
  })

  it('goes green when accepted, keeping the reason it was skipped', () => {
    const gate = gatesFor(skipped, ['unit']).byId('unit')

    expect(gate.status).toBe('pass')
    expect(gate.value).toBe('accepted')
    expect(gate.sub).toContain('no runner here')
  })
})
