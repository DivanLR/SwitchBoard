// The verification run's contract with the session: what it is asked to run, and
// what is trusted from its answer. The rule under test throughout is FR-072 —
// a figure nothing measured must come back null, never a number.
import { describe, expect, it } from 'vitest'
import { verifyVerdict } from '@shared/domain'
import { stackById, defaultSelection, unavailableReason } from '@shared/test-catalog'
import { parseVerifyReport, planSuites, verifyPrompt, VERIFY_MARKER } from '@main/evals/verify-dispatch'

const dotnet = stackById('dotnet')!
const node = stackById('node')!

describe('planning a run', () => {
  it('marks the suites the bypass container cannot run, instead of attempting them', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit', 'dotnet-arch'], true)
    expect(plan).toHaveLength(2)
    expect(plan.every((p) => p.unavailable?.includes('dotnet'))).toBe(true)

    // The same suites are fine when the session runs on the host.
    expect(planSuites(dotnet.suites, ['dotnet-unit'], false)[0].unavailable).toBeNull()
  })

  it('keeps node suites runnable in the container, but not browser ones', () => {
    expect(unavailableReason(node.suites.find((s) => s.id === 'node-unit')!, true)).toBeNull()
    expect(unavailableReason(node.suites.find((s) => s.id === 'node-e2e')!, true)).toContain('browser')
  })

  it('leaves slow suites out of the default selection, and unavailable ones too', () => {
    const chosen = defaultSelection(node.suites, true)
    expect(chosen).toContain('node-unit')
    expect(chosen).not.toContain('node-mutation') // heavy: opt in per run
    expect(chosen).not.toContain('node-e2e') // no browser in the container
  })

  it('tells the session what not to attempt, and why', () => {
    const prompt = verifyPrompt(planSuites(dotnet.suites, ['dotnet-unit'], true), '.NET', true)
    expect(prompt).toContain('Do NOT attempt these')
    expect(prompt).toContain('dotnet is not in the bypass container')
    expect(prompt).toContain(VERIFY_MARKER)
  })
})

describe('reading the report back', () => {
  const line = (json: string): string => `Ran everything.\n\n${VERIFY_MARKER}: ${json}`

  it('reads suites, coverage and the quality gate off the marker line', () => {
    const report = parseVerifyReport(
      line(
        JSON.stringify({
          suites: [{ id: 'node-unit', status: 'pass', detail: '142 passed' }],
          coverage: { line: { value: 81.4, source: 'vitest --coverage' }, changed: { value: 93, source: 'diff' }, files: [{ path: 'a.ts', pct: 40 }] },
          quality: { gate: 'pass', gateSource: 'sonarqube', duplication: { value: 1.2, source: 'sonarqube' }, debt: '2d 4h' },
        }),
      ),
    )
    expect(report?.suites[0]).toMatchObject({ id: 'node-unit', status: 'pass' })
    expect(report?.coverage.line.value).toBe(81.4)
    expect(report?.coverage.files).toEqual([{ path: 'a.ts', pct: 40 }])
    expect(report?.quality.gate).toBe('pass')
    expect(report?.quality.debt).toBe('2d 4h')
    expect(verifyVerdict(report!)).toBe('pass')
  })

  it('keeps an unmeasured figure null rather than turning it into zero', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"node-unit","status":"pass","detail":""}],"coverage":{"line":"unknown"},"quality":{"gate":"not_configured","mutation":null}}'),
    )
    expect(report?.coverage.line).toEqual({ value: null, source: null })
    expect(report?.quality.mutation.value).toBeNull()
    expect(report?.quality.gate).toBe('not_configured')
  })

  it('accepts the shapes a model actually emits: percent strings, fences, prose after', () => {
    const report = parseVerifyReport(
      `${VERIFY_MARKER}: \`\`\`json\n{"suites":[{"id":"py-unit","status":"PASS","detail":"9 passed"}],"coverage":{"line":"82%"}}\n\`\`\``,
    )
    expect(report?.suites[0].status).toBe('pass')
    expect(report?.coverage.line.value).toBe(82)
  })

  it('takes the LAST marker, so the prompt echoing the sentinel is never the answer', () => {
    const report = parseVerifyReport(
      `I will finish with ${VERIFY_MARKER}: {"suites":[{"id":"node-unit","status":"fail","detail":"echo"}]}\n` +
        `${VERIFY_MARKER}: {"suites":[{"id":"node-unit","status":"pass","detail":"real"}]}`,
    )
    expect(report?.suites[0].detail).toBe('real')
  })

  it('refuses a status it does not recognise, rather than reading it as a pass', () => {
    const report = parseVerifyReport(line('{"suites":[{"id":"node-unit","status":"probably fine","detail":""}]}'))
    expect(report?.suites[0].status).toBe('not_run')
    expect(verifyVerdict(report!)).toBe('inconclusive')
  })

  it('returns nothing when there is no marker or the JSON is broken', () => {
    expect(parseVerifyReport('All tests passed!')).toBeNull()
    expect(parseVerifyReport(line('{"suites": [oops}'))).toBeNull()
  })

  it('fails the run when any executed suite failed, whatever the quality figures say', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"node-unit","status":"pass","detail":""},{"id":"node-api","status":"fail","detail":"500 on /orders"}],"quality":{"gate":"pass"}}'),
    )
    expect(verifyVerdict(report!)).toBe('fail')
  })

  it('is inconclusive when everything was skipped — a skip is not a pass', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"dotnet-unit","status":"skipped","detail":"dotnet is not in the bypass container"}]}'),
    )
    expect(verifyVerdict(report!)).toBe('inconclusive')
  })
})
