/**
 * Reading a run's real artefacts, so a gate does not rest on what the session
 * SAID happened.
 *
 * The session reports one machine-readable line, and a schema-constrained line is
 * a guarantee about its shape and nothing at all about whether its values are
 * true. The published failure modes are specific and they all point the same way:
 * an agent evaluated inside the same working tree it just edited can make a claim
 * look true from in there (UC Berkeley RDI scored 500/500 on SWE-bench Verified
 * with a ten-line conftest.py hook and no bug fixed), frontier models have been
 * measured rewriting the scoring code itself (METR), and asking a second model to
 * grade the first one narrows nothing measurably (the generation-verification gap;
 * multi-agent debate not beating single-agent CoT; LLM-judge verdicts on identical
 * code swinging ~43%→~61% on answer order alone).
 *
 * So the fix here is not another opinion. It is a parser: every suite command is
 * made to leave a file behind, and the app reads THAT. Where the file and the
 * session disagree, the file wins and the disagreement is recorded rather than
 * quietly resolved — the same shape as dorny/test-reporter, which parses the
 * result file directly instead of asking anyone to summarise it.
 *
 * Pure and DOM-free: discovery injects its own filesystem, so all of this is unit
 * testable in plain node.
 *
 * ponytail: the two XML formats are read by attribute regex, not a real parser.
 * TRX's <Counters> and Cobertura's <coverage> are both single fixed elements with
 * numeric attributes, and every function here returns null rather than a guess
 * when the shape is not what it expected. Reach for an XML dependency only if a
 * format we actually need stops being expressible this way.
 */
import type { Measured, SuiteResult, VerifyReport } from '@shared/domain'

/** Counts as the test runner itself recorded them. */
export interface TrxCounts {
  total: number
  passed: number
  failed: number
  skipped: number
}

/**
 * A TRX result summary. `dotnet test --logger trx` writes this under
 * `TestResults/`; the counters are the runner's own tally, not a narration of it.
 */
export function parseTrx(xml: string): TrxCounts | null {
  const counters = /<Counters\b([^>]*)\/?>/i.exec(xml)
  if (!counters) return null
  const attr = (name: string): number | null => {
    const found = new RegExp(`\\b${name}="(\\d+)"`, 'i').exec(counters[1])
    return found ? Number(found[1]) : null
  }
  const total = attr('total')
  const passed = attr('passed')
  const failed = attr('failed')
  if (total === null || passed === null || failed === null) return null
  // TRX splits "did not run" across several counters; anything neither passed nor
  // failed did not produce a result, which is a state of its own, never a pass.
  return { total, passed, failed, skipped: Math.max(0, total - passed - failed) }
}

/** Total line coverage as a percentage, from a Cobertura report's own rate. */
export function parseCobertura(xml: string): number | null {
  const rate = /<coverage\b[^>]*\bline-rate="([0-9.]+)"/i.exec(xml)
  if (!rate) return null
  const value = Number(rate[1])
  if (!Number.isFinite(value) || value < 0 || value > 1) return null
  return Math.round(value * 1000) / 10
}

export interface MutationCounts {
  score: number
  detected: number
  valid: number
}

/**
 * Stryker's own mutation report.
 *
 * The score is Stryker's documented formula — detected / valid, where detected is
 * Killed + Timeout and valid excludes CompileError and RuntimeError mutants, which
 * are artefacts of mutation rather than evidence about the tests. Computing it here
 * rather than reading a percentage out of the session's prose is the whole point.
 */
export function parseStryker(json: string): MutationCounts | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const files = (parsed as { files?: Record<string, { mutants?: { status?: string }[] }> })?.files
  if (!files || typeof files !== 'object') return null
  const tally = new Map<string, number>()
  for (const file of Object.values(files)) {
    for (const mutant of file?.mutants ?? []) {
      const status = String(mutant?.status ?? '').toLowerCase()
      tally.set(status, (tally.get(status) ?? 0) + 1)
    }
  }
  const count = (status: string): number => tally.get(status) ?? 0
  const detected = count('killed') + count('timeout')
  const undetected = count('survived') + count('nocoverage')
  const valid = detected + undetected
  if (valid === 0) return null
  return { score: Math.round((detected / valid) * 1000) / 10, detected, valid }
}

/** The artefact files a run left behind, already read. */
export interface RunArtefacts {
  trx: { path: string; counts: TrxCounts } | null
  coverage: { path: string; line: number } | null
  mutation: { path: string; counts: MutationCounts } | null
}

/** One directory entry, as `walk` reports it. */
export interface ArtefactFile {
  /** Path as it should be shown to the developer — the source of a figure. */
  path: string
  /** Higher is newer. Used only to pick the most recent of several. */
  mtime: number
}

/**
 * The newest artefact of each kind a run produced.
 *
 * `walk` lists candidate files and `read` opens one, both injected. Nothing here
 * fabricates a path: a kind with no file stays null, and the caller reports that
 * figure as unmeasured rather than substituting one.
 */
export function collectArtefacts(
  walk: () => ArtefactFile[],
  read: (path: string) => string | null,
): RunArtefacts {
  const files = walk()
  const newest = (match: (path: string) => boolean): ArtefactFile | null =>
    files
      .filter((file) => match(file.path.replace(/\\/g, '/').toLowerCase()))
      .sort((a, b) => b.mtime - a.mtime)[0] ?? null

  const trxFile = newest((path) => path.endsWith('.trx'))
  const coverageFile = newest((path) => path.endsWith('cobertura.xml') || path.endsWith('cobertura-coverage.xml'))
  const mutationFile = newest((path) => /mutation-report\.json$/.test(path))

  const of = <T>(file: ArtefactFile | null, parse: (text: string) => T | null): { path: string; parsed: T } | null => {
    if (!file) return null
    const text = read(file.path)
    if (!text) return null
    const parsed = parse(text)
    return parsed === null ? null : { path: file.path, parsed }
  }

  const trx = of(trxFile, parseTrx)
  const coverage = of(coverageFile, parseCobertura)
  const mutation = of(mutationFile, parseStryker)
  return {
    trx: trx && { path: trx.path, counts: trx.parsed },
    coverage: coverage && { path: coverage.path, line: coverage.parsed },
    mutation: mutation && { path: mutation.path, counts: mutation.parsed },
  }
}

/** A place where the artefact and the session did not say the same thing. */
export interface Disagreement {
  /** What the artefact settled: a suite id, or 'coverage' / 'mutation'. */
  about: string
  /** The session's claim, then what the file actually said. */
  said: string
  measured: string
}

export interface Reconciled {
  report: VerifyReport
  disagreements: Disagreement[]
}

/** Suites whose result a test-runner artefact can actually speak to. */
const RUNNER_SUITES = /^(dotnet-(unit|coverage|api|arch)|node-unit|ng-unit|py-unit)$/

/**
 * Replace what the session claimed with what the artefacts measured, wherever an
 * artefact exists.
 *
 * Rules, in the order they matter:
 *   - A runner artefact reporting failures outranks a suite the session called a
 *     pass. The suite becomes a failure and the disagreement is recorded.
 *   - A figure parsed from a file is marked verified and its source becomes the
 *     file's path, so the panel can show which figures the app checked itself.
 *   - No artefact changes nothing. A session-reported figure stays exactly as
 *     reported, unverified — it is not promoted, and it is not thrown away.
 */
export function reconcile(report: VerifyReport, artefacts: RunArtefacts): Reconciled {
  const disagreements: Disagreement[] = []

  const suites: SuiteResult[] = report.suites.map((suite) => {
    const counts = artefacts.trx?.counts
    if (!counts || !RUNNER_SUITES.test(suite.id)) return suite
    const tally = `${counts.passed} passed, ${counts.failed} failed${counts.skipped > 0 ? `, ${counts.skipped} did not run` : ''}`
    if (counts.failed > 0 && suite.status === 'pass') {
      disagreements.push({
        about: suite.id,
        said: `pass — ${suite.detail}`,
        measured: `${tally} (${artefacts.trx?.path})`,
      })
      return { ...suite, status: 'fail', detail: `${tally}, per ${artefacts.trx?.path}`, verified: true }
    }
    // Agreement still gets the runner's own counts: the figures on screen then
    // come from the file rather than from a sentence about the file.
    if (suite.status === 'pass' || suite.status === 'fail') {
      return { ...suite, detail: `${tally}, per ${artefacts.trx?.path}`, verified: true }
    }
    return suite
  })

  const measured = (from: { path: string; value: number } | null, reported: Measured, about: string): Measured => {
    if (!from) return reported
    if (reported.value !== null && Math.abs(reported.value - from.value) >= 0.5) {
      disagreements.push({
        about,
        said: `${reported.value}%${reported.source ? ` (${reported.source})` : ''}`,
        measured: `${from.value}% (${from.path})`,
      })
    }
    return { value: from.value, source: from.path, verified: true }
  }

  return {
    report: {
      ...report,
      suites,
      coverage: {
        ...report.coverage,
        line: measured(
          artefacts.coverage && { path: artefacts.coverage.path, value: artefacts.coverage.line },
          report.coverage.line,
          'coverage',
        ),
      },
      quality: {
        ...report.quality,
        mutation: measured(
          artefacts.mutation && { path: artefacts.mutation.path, value: artefacts.mutation.counts.score },
          report.quality.mutation,
          'mutation',
        ),
      },
    },
    disagreements,
  }
}
