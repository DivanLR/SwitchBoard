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

/**
 * The text following the LAST `MARKER:` in a turn, or null when the marker never
 * appears.
 *
 * The last one wins because the prompt itself names the sentinel and a turn may
 * restate it, so an early mention must never be read as the answer. Returning
 * null only for a genuine absence is what lets a caller tell "the session never
 * reported" apart from "the session reported something unreadable" — two states
 * that used to be the same value and needed opposite explanations.
 */
export function markerTail(text: string, marker: string): string | null {
  const at = text.lastIndexOf(`${marker}:`)
  return at < 0 ? null : text.slice(at + marker.length + 1)
}

/**
 * The first complete JSON object in `text`, located by counting braces.
 *
 * This replaced a slice that ran from the first `{` to the LAST `}` in the rest
 * of the turn. That slice is correct only when the JSON is the final thing the
 * model writes: a single closing brace anywhere in the prose after it — a
 * parenthetical, a code reference, an example — extended the slice past the real
 * end and JSON.parse threw on a report that was perfectly well formed. The run
 * then read as "nothing was measured", which is the opposite of what happened.
 *
 * Braces inside string literals do not count, escapes included, so a path or a
 * body containing one cannot end the object early.
 */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  // Unbalanced: the turn was cut off mid-object, or the braces never closed.
  return null
}
