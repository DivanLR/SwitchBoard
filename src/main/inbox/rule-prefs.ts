import type { RiskClassificationRule, RiskLevel, RuleKind, SwallowRule } from '@shared/domain'
import { defaultRiskRules } from './risk-rules'
import { defaultSwallowRules } from '@main/stream/swallow-rules'

export type { RuleKind }

export interface RulePref {
  id: string
  kind: RuleKind
  disabled: boolean
  risk: RiskLevel | null
  body: string | null
  position: number | null
}

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

function customs<T>(prefs: RulePref[], kind: RuleKind): T[] {
  return prefs
    .filter((p) => p.kind === kind && p.body !== null && !p.disabled)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((p) => parse<T>(p.body as string))
    .filter((r): r is T => r !== null)
}

export function effectiveRiskRules(prefs: RulePref[]): RiskClassificationRule[] {
  const overrides = new Map(prefs.filter((p) => p.kind === 'risk').map((p) => [p.id, p]))
  const shipped = defaultRiskRules()
    .filter((rule) => !overrides.get(rule.id)?.disabled)
    .map((rule) => {
      const risk = overrides.get(rule.id)?.risk
      return risk ? { ...rule, risk } : rule
    })
  return [...customs<RiskClassificationRule>(prefs, 'risk'), ...shipped].map((rule, index) => ({
    ...rule,
    position: index,
  }))
}

export function effectiveSwallowRules(prefs: RulePref[]): SwallowRule[] {
  const overrides = new Map(prefs.filter((p) => p.kind === 'swallow').map((p) => [p.id, p]))
  const shipped = defaultSwallowRules().filter((rule) => !overrides.get(rule.id)?.disabled)
  return [...customs<SwallowRule>(prefs, 'swallow'), ...shipped].map((rule, index) => ({
    ...rule,
    position: index,
  }))
}
