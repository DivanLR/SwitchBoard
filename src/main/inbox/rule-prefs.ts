import type { RiskClassificationRule, RiskLevel, RuleKind, SwallowRule } from '@shared/domain'
import type { RulesView } from '@shared/ipc-types'
import { defaultRiskRules, riskRuleLabel } from './risk-rules'
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

export function rulesView(prefs: RulePref[]): RulesView {
  const riskOverrides = new Map(prefs.filter((p) => p.kind === 'risk').map((p) => [p.id, p]))
  const swallowOverrides = new Map(prefs.filter((p) => p.kind === 'swallow').map((p) => [p.id, p]))

  const customRisk = prefs
    .filter((p) => p.kind === 'risk' && p.body !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .flatMap((p) => {
      const rule = parse<RiskClassificationRule>(p.body as string)
      return rule
        ? [
            {
              id: p.id,
              builtin: false,
              label: `${rule.toolMatcher}${rule.inputMatcher ? ` matching ${rule.inputMatcher.pattern}` : ''}`,
              toolMatcher: rule.toolMatcher,
              pattern: rule.inputMatcher?.pattern ?? null,
              risk: rule.risk,
              overridden: false,
              disabled: p.disabled,
            },
          ]
        : []
    })

  const shippedRisk = defaultRiskRules().map((rule) => {
    const pref = riskOverrides.get(rule.id)
    return {
      id: rule.id,
      builtin: true,
      label: riskRuleLabel(rule.id),
      toolMatcher: rule.toolMatcher,
      pattern: rule.inputMatcher?.pattern ?? null,
      risk: pref?.risk ?? rule.risk,
      overridden: Boolean(pref?.risk),
      disabled: pref?.disabled ?? false,
    }
  })

  const customSwallow = prefs
    .filter((p) => p.kind === 'swallow' && p.body !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .flatMap((p) => {
      const rule = parse<SwallowRule>(p.body as string)
      return rule
        ? [
            {
              id: p.id,
              builtin: false,
              eventKindMatcher: rule.eventKindMatcher,
              pattern: rule.pattern,
              noiseKind: rule.noiseKind,
              disabled: p.disabled,
            },
          ]
        : []
    })

  const shippedSwallow = defaultSwallowRules().map((rule) => ({
    id: rule.id,
    builtin: true,
    eventKindMatcher: rule.eventKindMatcher,
    pattern: rule.pattern,
    noiseKind: rule.noiseKind,
    disabled: swallowOverrides.get(rule.id)?.disabled ?? false,
  }))

  return {
    risk: [...customRisk, ...shippedRisk],
    swallow: [...customSwallow, ...shippedSwallow],
  }
}
