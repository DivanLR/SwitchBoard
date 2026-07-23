// Inline interactive questions asked in plain assistant text (Spec Kit's
// /speckit-clarify idiom: "Question N of M", an options table, and "reply with
// the option letter"). The mapper uses the detector to keep these as plain
// assistant text (a question to the user is not a ✦ SUMMARY); the session view
// uses the parser to render a clickable answer card under the latest one.
import type { QuestionPayload } from './domain'

const QUESTION_MARKERS = [/question\s+\d+\s+of\s+\d+/i, /reply with (?:the )?option letter/i]

/** True when a turn-final message is an inline question awaiting a reply. */
export function isInteractiveQuestion(text: string): boolean {
  return QUESTION_MARKERS.some((m) => m.test(text))
}

const RECOMMENDED = /recommended:?\s*option\s+([A-Za-z][\w-]*)/i
// Table rows survive markdown flowing onto one line ("| A | desc | | B | …"):
// each match consumes "label | description |".
const ROW = /\|\s*([A-Za-z][A-Za-z0-9 _-]{0,20}?)\s*\|\s*([^|]{3,}?)\s*\|/g

/**
 * Parse the options table out of an inline question into a QuestionPayload for
 * the shared QuestionEvent card. Returns null when the text is not an inline
 * question or has fewer than two selectable options. The "Short"/free-text row
 * is dropped — the card's own "+ Other" input covers it.
 */
export function parseInlineQuestion(text: string): QuestionPayload | null {
  if (!isInteractiveQuestion(text)) return null
  const recommended = RECOMMENDED.exec(text)?.[1]?.toLowerCase() ?? null
  const options: QuestionPayload['options'] = []
  for (const m of text.matchAll(ROW)) {
    const label = m[1].trim()
    const description = m[2].trim()
    if (/^option$/i.test(label) || /^-+$/.test(label)) continue // header/separator
    if (/^short$/i.test(label) || /own (?:short )?answer/i.test(description)) continue
    if (options.some((o) => o.label.toLowerCase().startsWith(label.toLowerCase()))) continue
    options.push({
      label: label.toLowerCase() === recommended ? `${label} (Recommended)` : label,
      description,
    })
  }
  if (options.length < 2) return null
  return {
    text: 'Quick answer — pick an option or type your own.',
    options,
    answered: false,
  }
}
