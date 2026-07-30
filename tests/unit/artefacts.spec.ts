// Reading a run's real artefacts instead of trusting what the session said about
// them. The whole point of these tests is the disagreement case: a report line is
// schema-valid whether or not it is true, so the file has to be able to overrule it.
import { describe, expect, it } from 'vitest'
import { emptyVerifyReport, verifyVerdict, type VerifyReport } from '@shared/domain'
import {
  collectArtefacts,
  parseCobertura,
  parseStryker,
  parseTrx,
  reconcile,
  type RunArtefacts,
} from '@main/evals/artefacts'

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="a" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <ResultSummary outcome="Failed">
    <Counters total="318" executed="317" passed="315" failed="2" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="1" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>`

const COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.782" branch-rate="0.6112" version="1.9" timestamp="1700000000">
  <packages />
</coverage>`

const STRYKER = JSON.stringify({
  schemaVersion: '1',
  files: {
    'src/A.cs': {
      mutants: [
        { status: 'Killed' },
        { status: 'Killed' },
        { status: 'Timeout' },
        { status: 'Survived' },
        // Excluded from the score: these are artefacts of mutating, not evidence
        // about the tests.
        { status: 'CompileError' },
        { status: 'RuntimeError' },
      ],
    },
    'src/B.cs': { mutants: [{ status: 'NoCoverage' }] },
  },
})

describe('artefact parsing', () => {
  it('reads the runner\u2019s own counters out of a TRX file', () => {
    expect(parseTrx(TRX)).toEqual({ total: 318, passed: 315, failed: 2, skipped: 1 })
  })

  it('reads total line coverage from a Cobertura report', () => {
    expect(parseCobertura(COBERTURA)).toBe(78.2)
  })

  it("computes Stryker's documented score: detected over valid", () => {
    // detected = Killed(2) + Timeout(1) = 3; undetected = Survived(1) + NoCoverage(1) = 2;
    // valid = 5, so 60%. CompileError and RuntimeError are excluded from both.
    expect(parseStryker(STRYKER)).toEqual({ score: 60, detected: 3, valid: 5 })
  })

  it('returns null rather than a guess on anything it does not recognise', () => {
    expect(parseTrx('<TestRun />')).toBeNull()
    expect(parseTrx('not xml at all')).toBeNull()
    expect(parseCobertura('<coverage branch-rate="0.5" />')).toBeNull()
    expect(parseCobertura('<coverage line-rate="7" />')).toBeNull() // a rate is 0..1
    expect(parseStryker('{')).toBeNull()
    expect(parseStryker('{"files":{}}')).toBeNull()
    expect(parseStryker(JSON.stringify({ files: { a: { mutants: [{ status: 'CompileError' }] } } }))).toBeNull()
  })
})

describe('artefact discovery', () => {
  const files = [
    { path: 'C:/p/TestResults/old.trx', mtime: 100 },
    { path: 'C:/p/TestResults/new.trx', mtime: 900 },
    { path: 'C:/p/TestResults/guid/coverage.cobertura.xml', mtime: 900 },
    { path: 'C:/p/StrykerOutput/2026/reports/mutation-report.json', mtime: 800 },
    { path: 'C:/p/TestResults/notes.txt', mtime: 950 },
  ]
  const read = (path: string): string | null =>
    path.endsWith('.trx')
      ? TRX
      : path.endsWith('cobertura.xml')
        ? COBERTURA
        : path.endsWith('mutation-report.json')
          ? STRYKER
          : null

  it('takes the newest file of each kind', () => {
    const found = collectArtefacts(() => files, read)
    expect(found.trx?.path).toBe('C:/p/TestResults/new.trx')
    expect(found.trx?.counts.failed).toBe(2)
    expect(found.coverage?.line).toBe(78.2)
    expect(found.mutation?.counts.score).toBe(60)
  })

  it('reports a kind with no file as absent, never as a zero', () => {
    const found = collectArtefacts(() => [{ path: 'C:/p/TestResults/notes.txt', mtime: 1 }], read)
    expect(found).toEqual({ trx: null, coverage: null, mutation: null })
  })

  it('treats an unreadable file as absent', () => {
    const found = collectArtefacts(() => files, () => null)
    expect(found.trx).toBeNull()
  })
})

const reported = (over: Partial<VerifyReport> = {}): VerifyReport => ({
  ...emptyVerifyReport(),
  ...over,
})

const artefacts = (over: Partial<RunArtefacts> = {}): RunArtefacts => ({
  trx: null,
  coverage: null,
  mutation: null,
  ...over,
})

describe('settling a report against its artefacts', () => {
  it('overrules a claimed pass when the runner recorded failures', () => {
    const settled = reconcile(
      reported({ suites: [{ id: 'dotnet-unit', label: 'Unit tests', status: 'pass', detail: 'all 318 green' }] }),
      artefacts({ trx: { path: 'TestResults/x.trx', counts: { total: 318, passed: 315, failed: 2, skipped: 1 } } }),
    )
    expect(settled.report.suites[0].status).toBe('fail')
    expect(settled.report.suites[0].verified).toBe(true)
    expect(settled.report.suites[0].detail).toContain('2 failed')
    expect(settled.disagreements).toHaveLength(1)
    expect(settled.disagreements[0].about).toBe('dotnet-unit')
    // ...and the run's verdict follows the artefact, not the claim.
    expect(verifyVerdict(settled.report)).toBe('fail')
  })

  it('replaces a reported figure with the measured one and marks it verified', () => {
    const settled = reconcile(
      reported({ coverage: { line: { value: 95, source: 'I read the report' }, changed: { value: null, source: null }, files: [] } }),
      artefacts({ coverage: { path: 'TestResults/g/coverage.cobertura.xml', line: 78.2 } }),
    )
    expect(settled.report.coverage.line).toEqual({
      value: 78.2,
      source: 'TestResults/g/coverage.cobertura.xml',
      verified: true,
    })
    expect(settled.disagreements[0].said).toContain('95%')
    expect(settled.disagreements[0].measured).toContain('78.2%')
  })

  it('marks an agreeing figure verified without inventing a disagreement', () => {
    const settled = reconcile(
      reported({ quality: { ...emptyVerifyReport().quality, mutation: { value: 60, source: 'stryker' } } }),
      artefacts({ mutation: { path: 'StrykerOutput/r/mutation-report.json', counts: { score: 60, detected: 3, valid: 5 } } }),
    )
    expect(settled.report.quality.mutation.verified).toBe(true)
    expect(settled.disagreements).toEqual([])
  })

  it('leaves everything alone when there is no artefact, rather than voiding the report', () => {
    const before = reported({
      suites: [{ id: 'dotnet-unit', label: 'Unit tests', status: 'pass', detail: 'all green' }],
      coverage: { line: { value: 91, source: 'coverage report' }, changed: { value: null, source: null }, files: [] },
    })
    const settled = reconcile(before, artefacts())
    expect(settled.report).toEqual(before)
    expect(settled.report.suites[0].verified).toBeUndefined()
    expect(settled.report.coverage.line.verified).toBeUndefined()
    expect(settled.disagreements).toEqual([])
  })

  it('does not let a test-runner artefact speak for a suite it knows nothing about', () => {
    // The endpoint pass and the browser suites are prose instructions; no TRX file
    // is evidence about them, so a failing TRX must not silently fail them too.
    const settled = reconcile(
      reported({
        suites: [
          { id: 'dotnet-http', label: 'HTTP smoke', status: 'pass', detail: 'every endpoint answered' },
          { id: 'blazor-ui', label: 'Screens', status: 'pass', detail: 'screens worked' },
        ],
      }),
      artefacts({ trx: { path: 'x.trx', counts: { total: 3, passed: 1, failed: 2, skipped: 0 } } }),
    )
    expect(settled.report.suites.map((s) => s.status)).toEqual(['pass', 'pass'])
    expect(settled.report.suites[0].verified).toBeUndefined()
    expect(settled.disagreements).toEqual([])
  })

  it('does not promote a suite the run never reached', () => {
    const settled = reconcile(
      reported({ suites: [{ id: 'dotnet-arch', label: 'Architecture', status: 'not_run', detail: 'the run stopped earlier' }] }),
      artefacts({ trx: { path: 'x.trx', counts: { total: 10, passed: 10, failed: 0, skipped: 0 } } }),
    )
    expect(settled.report.suites[0].status).toBe('not_run')
    expect(settled.report.suites[0].verified).toBeUndefined()
  })
})
