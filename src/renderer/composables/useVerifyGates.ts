// The six verification gates: what each tile says once a run has, or has not,
// measured it. Extracted from TestsView so the view is left rendering panels.
//
// Two rules run through all of this and are the reason it is worth its own file.
// A figure nothing measured reads "—" with the reason, never a number nothing
// produced (FR-072). And a suite that never executed is neither a pass nor a
// failure — a skipped suite is a warning that says so, because reporting an
// absent measurement as success is the one thing this section must not do.
import { computed, type ComputedRef } from 'vue'
import { suiteById, VERIFY_GATES, type VerifyGate } from '@shared/test-catalog'
import type { Measured, VerifyRun } from '@shared/domain'

/** What a tile shows once the run has (or has not) measured it. */
export interface GateFace {
  status: 'pass' | 'fail' | 'warn' | 'none'
  value: string
  sub: string
  /**
   * True when the app read this out of the runner's own artefact file, rather
   * than taking the session's word for it. The distinction is worth a mark on
   * the tile: a report line is schema-valid whether or not it is true, so a
   * figure the app checked itself is different evidence from the same figure
   * typed into a report.
   */
  verified?: boolean
}

export type GateView = VerifyGate & GateFace

/** The figure nothing measured — rendered as "—" everywhere it appears. */
export const unmeasured: Measured = { value: null, source: null }

export const round = (n: number): number => Math.round(n * 10) / 10
export const pct = (m: Measured): string => (m.value === null ? '—' : `${round(m.value)}%`)
export const sourceOf = (m: Measured, fallback = 'nothing measured it'): string =>
  m.source ?? fallback

export function useVerifyGates(latest: ComputedRef<VerifyRun | null>) {
  /** Suites of the latest run whose catalog kind matches, ignoring ones that
   *  never executed — a skipped suite is not a pass and not a failure. */
  function suiteGate(kinds: readonly string[]): GateFace {
    const results = (latest.value?.report?.suites ?? []).filter((r) => {
      const kind = suiteById(r.id)?.kind
      return kind !== undefined && kinds.includes(kind)
    })
    const executed = results.filter((r) => r.status === 'pass' || r.status === 'fail')
    if (executed.length === 0) {
      const skipped = results.find((r) => r.status === 'skipped' || r.status === 'unavailable')
      if (skipped) return { status: 'warn', value: 'skipped', sub: skipped.detail || 'not run here' }
      return { status: 'none', value: '—', sub: latest.value ? 'not in this run' : 'no run yet' }
    }
    const failed = executed.filter((r) => r.status === 'fail')
    // Only when EVERY executed suite was settled by an artefact: one unverified
    // suite in the set means the tile as a whole was not checked against a file.
    const verified = executed.every((r) => r.verified === true)
    if (failed.length > 0) {
      return {
        status: 'fail',
        value: 'failed',
        sub: failed[0].detail || `${failed.length} suite(s) failed`,
        verified,
      }
    }
    return { status: 'pass', value: 'passed', sub: `${executed.length} suite(s)`, verified }
  }

  /** A measured figure against its threshold. Under target is a warning, never a
   *  failure: quality never flips a run's verdict (FR-071). */
  function figureGate(m: Measured, minimum: number, sub?: string): GateFace {
    if (m.value === null) {
      return {
        status: 'none',
        value: '—',
        sub: latest.value ? 'not measured in this run' : 'no run yet',
      }
    }
    const meets = m.value >= minimum
    return {
      status: meets ? 'pass' : 'warn',
      value: pct(m),
      // The word, not just the hue: a figure gate's only state cue was green vs
      // amber, and amber sits 27 degrees from the red used for failure.
      sub: `${meets ? 'meets target' : 'under target'} · ${sub ?? sourceOf(m)}`,
      verified: m.verified === true,
    }
  }

  const gates = computed<GateView[]>(() =>
    VERIFY_GATES.map((gate) => {
      const report = latest.value?.report
      const quality = report?.quality
      switch (gate.id) {
        case 'unit':
          return { ...gate, ...suiteGate(['unit']) }
        case 'integration': {
          // The integration gate answers "does the API work", so a failed real
          // call fails it even when the suite that made the call reported pass.
          // Without this the headline gate is green while the call that proves
          // the API is broken sits red in the panel below it.
          const face = suiteGate(['api'])
          const failed = (report?.endpoints ?? []).filter((e) => e.outcome === 'fail')
          if (failed.length === 0) return { ...gate, ...face }
          return {
            ...gate,
            status: 'fail',
            value: 'failed',
            sub:
              failed.length === 1
                ? `${failed[0].method} ${failed[0].path}`
                : `${failed.length} real endpoint calls failed`,
          }
        }
        case 'architecture': {
          const violations = quality?.archViolations
          if (!violations || violations.value === null) return { ...gate, ...suiteGate(['quality']) }
          return {
            ...gate,
            status: violations.value === 0 ? 'pass' : 'fail',
            value: String(violations.value),
            sub:
              violations.value === 0
                ? sourceOf(violations)
                : (quality?.findings[0] ?? 'rule violations'),
          }
        }
        case 'mutation':
          return { ...gate, ...figureGate(quality?.mutation ?? unmeasured, 70) }
        case 'coverage': {
          const changed = quality ? report?.coverage.changed : null
          const line = report?.coverage.line ?? unmeasured
          if (changed && changed.value !== null) {
            return {
              ...gate,
              ...figureGate(changed, 90, `${pct(changed)} of changed lines · line ${pct(line)}`),
            }
          }
          return { ...gate, ...figureGate(line, 80) }
        }
        default: {
          if (!quality?.gate || quality.gate === 'not_configured') {
            return {
              ...gate,
              status: 'none',
              value: '—',
              sub: latest.value ? 'no quality service connected' : 'no run yet',
            }
          }
          const dup = quality.duplication
          return {
            ...gate,
            status: quality.gate === 'pass' ? 'pass' : 'fail',
            value: quality.gate === 'pass' ? 'passed' : 'failed',
            sub: `${quality.gateSource ?? 'quality service'}${dup.value === null ? '' : ` · ${pct(dup)} duplication`}`,
          }
        }
      }
    }),
  )

  /**
   * One headline figure for the run: the share of gates that passed.
   *
   * Counted, not estimated, which is the only way a single number is allowed to
   * exist in this section (PRODUCT.md principle 2). Its denominator is the gates
   * the run actually measured — a gate reading "—" is excluded from both halves
   * rather than counted as a failure, for the same reason a skipped suite is
   * neither a pass nor a failure. So the figure answers "of what this run
   * measured, how much held", and `measured`/`total` are exposed beside it so the
   * tile can say what it left out instead of implying full coverage.
   *
   * A warning counts against it. An under-target coverage figure does not fail
   * the run (FR-071) but it is not a clean gate either, and a score that ignored
   * warnings would sit at 100% while two tiles were amber.
   *
   * Null when the run measured nothing at all, which renders as "—" like every
   * other unmeasured figure.
   */
  const score = computed(() => {
    const measured = gates.value.filter((g) => g.status !== 'none')
    if (measured.length === 0) return null
    const passed = measured.filter((g) => g.status === 'pass').length
    return {
      pct: Math.round((passed / measured.length) * 100),
      passed,
      measured: measured.length,
      total: gates.value.length,
    }
  })

  return { gates, score, suiteGate, figureGate }
}
