import { modelFamily } from '@shared/domain'

export function modelDeviation(reported: string | undefined, wanted: string | undefined): boolean {
  if (!reported || !wanted || wanted === 'default') return false
  const a = modelFamily(reported)
  const b = modelFamily(wanted)
  if (!a || !b) return false
  return a !== b
}
