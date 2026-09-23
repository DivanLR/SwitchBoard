import type { Measured, SuiteResult, VerifyReport } from '@shared/domain'

interface TrxCounts {
  total: number
  passed: number
  failed: number
  skipped: number
}

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
  return { total, passed, failed, skipped: Math.max(0, total - passed - failed) }
}

export function parseCobertura(xml: string): number | null {
  const rate = /<coverage\b[^>]*\bline-rate="([0-9.]+)"/i.exec(xml)
  if (!rate) return null
  const value = Number(rate[1])
  if (!Number.isFinite(value) || value < 0 || value > 1) return null
  return Math.round(value * 1000) / 10
}

interface MutationCounts {
  score: number
  detected: number
  valid: number
}

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

export interface RunArtefacts {
  trx: { path: string; counts: TrxCounts } | null
  coverage: { path: string; line: number } | null
  mutation: { path: string; counts: MutationCounts } | null
}

export interface ArtefactFile {
  path: string
  mtime: number
}

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

interface Disagreement {
  about: string
  said: string
  measured: string
}

interface Reconciled {
  report: VerifyReport
  disagreements: Disagreement[]
}

const RUNNER_SUITES = /^(dotnet-(unit|coverage|api|arch)|ng-unit)$/

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
