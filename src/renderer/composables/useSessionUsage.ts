import { computed, type ComputedRef } from 'vue'
import { modelLabel, type Session } from '@shared/domain'
import { useActiveSessionStore } from '@renderer/stores/activeSession'

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

  const cacheColor = computed(() =>
    (cacheHitPct.value ?? 0) > 50 ? 'var(--green)' : 'var(--amber)',
  )

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

  const currentModelLabel = computed(() => {
    const id = liveSession.value?.currentModel
    return id ? modelLabel(id) : null
  })

  return {
    cacheHitPct,
    cacheColor,
    sessionUsage,
    currentModelLabel,
  }
}
