/**
 * Tolerant readers for JSON a model produced.
 *
 * Shared by the eval dispatchers, which each held a copy. The copies had already
 * drifted: one accepted a bare number where text was expected, the other returned
 * null for it. The tolerant reading is the correct one and is what this keeps —
 * the whole reason these exist is that a model writes 200 as often as "200", and
 * dropping the value loses a real answer.
 */

/**
 * A non-empty string, or null.
 *
 * A number is rendered rather than rejected (see above). The placeholder words are
 * collapsed to null because a model writes them to mean "nothing measured this",
 * and carrying them through would show the developer the word "unknown" as if it
 * were a finding.
 */
export function str(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && !/^(null|n\/a|none|unknown)$/i.test(trimmed) ? trimmed : null
}
