// What the developer changed about the rules, applied over the shipped defaults.
//
// PRODUCT.md Principle 3: "The developer owns the rules. Risk classification,
// output swallowing, and standing permissions ship as editable defaults, never as
// fixed policy."
//
// The shape matters, because the obvious design is the one that already failed
// here. Copying the defaults into a table at first run made every later change to
// a shipped default unshippable: seedIfEmpty() will not re-seed a non-empty table,
// so the row kept the old value and the only way to move it was a hand-written
// migration per change (009-progress-rule-scope is the scar). The defaults are
// therefore the code, permanently, and this stores ONLY the difference: which
// shipped rules were switched off, which had their risk level changed, and which
// rules the developer wrote themselves.
//
// The consequences worth knowing:
//   - Editing a shipped default is a normal code change again. It reaches every
//     install that has not overridden that specific rule, with no migration.
//   - An override is keyed to a stable slug, so retiring a rule leaves an orphan
//     row. Orphans are ignored, which reads as "never touched it" — the safe way
//     round, since the alternative is resurrecting a rule that no longer exists.
import type { RiskClassificationRule, RiskLevel, RuleKind, SwallowRule } from '@shared/domain'
import type { RulesView } from '@shared/ipc-types'
import { defaultRiskRules, riskRuleLabel } from './risk-rules'
import { defaultSwallowRules } from '@main/stream/swallow-rules'

export type { RuleKind }

/** One row of "what the developer changed", for a shipped rule or their own. */
export interface RulePref {
  id: string
  kind: RuleKind
  disabled: boolean
  /** Risk rules only: the level chosen instead of the shipped one. */
  risk: RiskLevel | null
  /**
   * The whole rule as JSON, for a rule the developer wrote. Null for an override
   * of a shipped rule, whose body lives in code.
   */
  body: string | null
  /** Custom rules only: order among the developer's own rules. */
  position: number | null
}

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T
  } catch {
    // A row this process cannot read is a row it must not act on. Dropping it
    // leaves the shipped defaults in force, which is the conservative direction:
    // a rule that fails to load must never silently widen what is allowed.
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

/**
 * The risk rules actually in force.
 *
 * The developer's own rules come FIRST because classification is first-match-wins:
 * a rule someone wrote to say "this command is fine here" has to be able to beat
 * the shipped rule that would have called it destructive, or writing it achieved
 * nothing. Positions are renumbered so the engine's sort matches this order.
 */
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

/**
 * The noise rules actually in force.
 *
 * Same ordering reason as above. A disabled shipped rule is dropped rather than
 * emitted with `enabled: false`, so the classifier never has to know that
 * "disabled" has two possible sources.
 */
export function effectiveSwallowRules(prefs: RulePref[]): SwallowRule[] {
  const overrides = new Map(prefs.filter((p) => p.kind === 'swallow').map((p) => [p.id, p]))
  const shipped = defaultSwallowRules().filter((rule) => !overrides.get(rule.id)?.disabled)
  return [...customs<SwallowRule>(prefs, 'swallow'), ...shipped].map((rule, index) => ({
    ...rule,
    position: index,
  }))
}

/**
 * Every rule as the editor sees it, disabled ones included.
 *
 * Separate from the effective lists above, which exist for the engines and drop
 * what is switched off. The editor needs the opposite: it cannot offer to switch a
 * rule back on if it cannot see it.
 */
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

  // Same order the engines use, so what the editor lists top to bottom is the
  // order a match is actually decided in.
  return {
    risk: [...customRisk, ...shippedRisk],
    swallow: [...customSwallow, ...shippedSwallow],
  }
}
