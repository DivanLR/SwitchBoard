import { computed, type ComputedRef } from 'vue'
import { suiteById, VERIFY_GATES, type VerifyGate } from '@shared/test-catalog'
import type { Measured, VerifyRun } from '@shared/domain'

interface GateFace {
  status: 'pass' | 'fail' | 'warn' | 'none'
  value: string
  sub: string
  verified?: boolean
  acceptable?: boolean
  accepted?: boolean
}

type GateView = VerifyGate & GateFace

export const unmeasured: Measured = { value: null, source: null }

export const round = (n: number): number => Math.round(n * 10) / 10
export const pct = (m: Measured): string => (m.value === null ? '—' : `${round(m.value)}%`)
export const sourceOf = (m: Measured, fallback = 'nothing measured it'): string =>
  m.source ?? fallback

function isAcceptable(face: GateFace): boolean {
  return face.status === 'none' || (face.status === 'warn' && face.value === 'skipped')
}

export function useVerifyGates(
  latest: ComputedRef<VerifyRun | null>,
  accepted?: ComputedRef<ReadonlySet<string>>,
) {
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
      sub: `${meets ? 'meets target' : 'under target'} · ${sub ?? sourceOf(m)}`,
      verified: m.verified === true,
    }
  }

  function overlay(gate: VerifyGate, face: GateFace): GateView {
    const canAccept = isAcceptable(face)
    if (!canAccept || !accepted?.value.has(gate.id)) return { ...gate, ...face, acceptable: canAccept }
    return {
      ...gate,
      status: 'pass',
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

  const score = computed(() => {
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
