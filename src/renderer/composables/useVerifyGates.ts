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
  /**
   * True when there is no measurement here to contradict, so the developer may
   * mark the tile green themselves. False for every measured face, including a
   * figure that came back UNDER target — that is a real shortfall, and offering
   * to click it away would launder data rather than record a judgement.
   */
  acceptable?: boolean
  /** True when they have. The tile reads green and says who decided. */
  accepted?: boolean
}

export type GateView = VerifyGate & GateFace

/** The figure nothing measured — rendered as "—" everywhere it appears. */
export const unmeasured: Measured = { value: null, source: null }

export const round = (n: number): number => Math.round(n * 10) / 10
export const pct = (m: Measured): string => (m.value === null ? '—' : `${round(m.value)}%`)
export const sourceOf = (m: Measured, fallback = 'nothing measured it'): string =>
  m.source ?? fallback

/**
 * A face nothing measured, which is therefore a judgement the developer is
 * entitled to make. Two shapes qualify: the gate is absent from the run ('—'),
 * or its suite reported back that it never executed here.
 */
function isAcceptable(face: GateFace): boolean {
  return face.status === 'none' || (face.status === 'warn' && face.value === 'skipped')
}

/**
 * @param accepted Gate ids the developer has accepted for this project. Absent
 *   (the default) means none, which is what every caller but the Tests section
 *   wants — the overlay is a UI affordance, not part of a run's verdict.
 */
export function useVerifyGates(
  latest: ComputedRef<VerifyRun | null>,
  accepted?: ComputedRef<ReadonlySet<string>>,
) {
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

  /**
   * The face, plus whatever the developer has said about it.
   *
   * Deliberately applied AFTER the face is computed rather than inside each
   * branch: acceptance can then only ever see a finished verdict, so there is no
   * path by which it reaches a measured figure.
   */
  function overlay(gate: VerifyGate, face: GateFace): GateView {
    const canAccept = isAcceptable(face)
    if (!canAccept || !accepted?.value.has(gate.id)) return { ...gate, ...face, acceptable: canAccept }
    return {
      ...gate,
      status: 'pass',
      // Never a number and never the word "passed": this gate did not pass, it
      // was excused, and the tile has to keep saying which of the two happened.
      value: 'accepted',
      sub: `you accepted this · ${face.sub}`,
      acceptable: true,
      accepted: true,
    }
  }

  const gates = computed<GateView[]>(() =>
    VERIFY_GATES.map((gate) => {
      const report = latest.value?.report
      const quality = report?.quality
      switch (gate.id) {
        case 'unit':
          return overlay(gate, suiteGate(['unit']))
        case 'integration': {
          // The integration gate answers "does the API work", so a failed real
          // call fails it even when the suite that made the call reported pass.
          // Without this the headline gate is green while the call that proves
          // the API is broken sits red in the panel below it.
          const face = suiteGate(['api'])
          const failed = (report?.endpoints ?? []).filter((e) => e.outcome === 'fail')
          if (failed.length === 0) return overlay(gate, face)
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
          if (!violations || violations.value === null) return overlay(gate, suiteGate(['quality']))
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
          return overlay(gate, figureGate(quality?.mutation ?? unmeasured, 70))
        case 'coverage': {
          const changed = quality ? report?.coverage.changed : null
          const line = report?.coverage.line ?? unmeasured
          if (changed && changed.value !== null) {
            return overlay(
              gate,
              figureGate(changed, 90, `${pct(changed)} of changed lines · line ${pct(line)}`),
            )
          }
          return overlay(gate, figureGate(line, 80))
        }
        default: {
          if (!quality?.gate || quality.gate === 'not_configured') {
            return overlay(gate, {
              status: 'none',
              value: '—',
              sub: latest.value ? 'no quality service connected' : 'no run yet',
            })
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
   * One headline figure for the run: the share of gates that passed, counted
   * (not estimated — PRODUCT.md principle 2). The denominator is what the run
   * actually measured: a "—" gate is excluded, not counted as a failure, same as
   * an unexecuted suite — so the figure answers "of what this run measured, how
   * much held", and `measured`/`total` say what it left out.
   *
   * A warning (e.g. under-target coverage, FR-071) counts against it — ignoring
   * warnings would show 100% while a tile sat amber. Null when nothing was
   * measured, rendering "—" like any other unmeasured figure.
   */
  const score = computed(() => {
    // An ACCEPTED gate is excluded on the same grounds as a '—' one: it was not
    // measured. Counting it would put a judgement into a figure PRODUCT.md
    // principle 2 says is counted, and the tile already states it was accepted.
    const measured = gates.value.filter((g) => g.status !== 'none' && !g.accepted)
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
