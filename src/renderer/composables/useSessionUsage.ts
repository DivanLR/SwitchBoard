// The session header's usage readouts: the subscription rate-limit meter, the
// prompt-cache hit rate for the latest turn, and the per-model token/cost
// totals. Extracted from SessionView so the view stays focused on rendering the
// stream; these five figures are read together, in one strip, and share nothing
// with the rest of it.
//
// Every figure here is REPORTED, never estimated. The rate-limit meter is the
// subscription's own signal rather than a token guess, the cache rate comes off
// the turn's own usage block, and the totals are what the SDK billed. An absent
// figure stays null and renders as "—", because a placeholder number in a
// spend readout is worse than no number.
import { computed, type ComputedRef } from 'vue'
import { modelLabel, type Session } from '@shared/domain'
import { useActiveSessionStore } from '@renderer/stores/activeSession'

/** Compact token count: 1.2M, 340k, 512. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export interface SessionUsageTotals {
  total: number
  cost: number
  top: { id: string; label: string; tokens: number }[]
}

export function useSessionUsage(liveSession: ComputedRef<Session | null>) {
  const active = useActiveSessionStore()

  const usagePct = computed(() => {
    const u = liveSession.value?.usageUtilization
    return u != null ? Math.max(0, Math.min(100, Math.round(u))) : null
  })

  const usageColor = computed(() => {
    const p = usagePct.value ?? 0
    return p > 85 ? 'var(--red)' : p > 60 ? 'var(--amber)' : 'var(--green)'
  })

  const usageLimitLabel = computed(() => {
    // 7d for a weekly window; otherwise the 5h label (also the pre-report placeholder).
    const t = liveSession.value?.usageLimitType
    return t?.startsWith('seven_day') ? '7d limit' : '5h limit'
  })

  /**
   * Prompt-cache hit rate for the latest completed turn: cache_read /
   * (cache_read + cache_creation + fresh input). A high number means the
   * conversation prefix is being reused instead of re-billed at full price.
   */
  const cacheHitPct = computed(() => {
    for (let i = active.events.length - 1; i >= 0; i -= 1) {
      const event = active.events[i]
      if (event.kind !== 'result') continue
      const usage = (event.payload as { usage?: Record<string, unknown> }).usage ?? {}
      const num = (key: string): number =>
        typeof usage[key] === 'number' ? (usage[key] as number) : 0
      const read = num('cache_read_input_tokens')
      const total = read + num('cache_creation_input_tokens') + num('input_tokens')
      if (total === 0) return null
      return Math.round((read / total) * 100)
    }
    return null
  })

  /** Same shape of threshold as usageColor, so both live in one place. */
  const cacheColor = computed(() =>
    (cacheHitPct.value ?? 0) > 50 ? 'var(--green)' : 'var(--amber)',
  )

  /** Session totals plus the two most-used models, for the header widget. */
  const sessionUsage = computed<SessionUsageTotals | null>(() => {
    const totals = liveSession.value?.modelTotals
    if (!totals) return null
    const models = Object.entries(totals).sort((a, b) => b[1].tokens - a[1].tokens)
    if (models.length === 0) return null
    return {
      total: models.reduce((sum, [, u]) => sum + u.tokens, 0),
      cost: models.reduce((sum, [, u]) => sum + u.costUsd, 0),
      top: models.slice(0, 2).map(([id, u]) => ({ id, label: modelLabel(id), tokens: u.tokens })),
    }
  })

  /** The model the SDK reported for the latest turn (reflects routing live). */
  const currentModelLabel = computed(() => {
    const id = liveSession.value?.currentModel
    return id ? modelLabel(id) : null
  })

  return {
    usagePct,
    usageColor,
    usageLimitLabel,
    cacheHitPct,
    cacheColor,
    sessionUsage,
    currentModelLabel,
  }
}
