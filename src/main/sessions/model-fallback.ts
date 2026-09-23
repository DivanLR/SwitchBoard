import { modelFamily } from '@shared/domain'

const DOWNGRADE: Record<string, string | null> = {
  fable: 'opus',
  opus: 'sonnet',
  sonnet: 'haiku',
  haiku: null,
}

export function nextStrongestModel(current: string | undefined): string | null {
  const family = modelFamily(current)
  if (!family) return 'sonnet'
  return DOWNGRADE[family] ?? null
}

export function modelDeviation(reported: string | undefined, wanted: string | undefined): boolean {
  if (!reported || !wanted || wanted === 'default') return false
  const a = modelFamily(reported)
  const b = modelFamily(wanted)
  if (!a || !b) return false
  return a !== b
}
