import type { QuestionPayload } from './domain'

const QUESTION_MARKERS = [/question\s+\d+\s+of\s+\d+/i, /reply with (?:the )?option letter/i]

export function isInteractiveQuestion(text: string): boolean {
  return QUESTION_MARKERS.some((m) => m.test(text))
}

const RECOMMENDED = /recommended:?\s*option\s+([A-Za-z][\w-]*)/i
const ROW = /\|\s*([A-Za-z][A-Za-z0-9 _-]{0,20}?)\s*\|\s*([^|]{3,}?)\s*\|/g

export function parseInlineQuestion(text: string): QuestionPayload | null {
  if (!isInteractiveQuestion(text)) return null
  const recommended = RECOMMENDED.exec(text)?.[1]?.toLowerCase() ?? null
  const options: QuestionPayload['options'] = []
  for (const m of text.matchAll(ROW)) {
    const label = m[1].trim()
    const description = m[2].trim()
    if (/^option$/i.test(label) || /^-+$/.test(label)) continue 
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

export function pendingQuestions(
  events: readonly { id: string; kind: string; payload: unknown }[],
  answeredIds: readonly string[] = [],
): { eventId: string; payload: QuestionPayload }[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.kind === 'prompt') return []
    if (event.kind === 'question') {
      const open: { eventId: string; payload: QuestionPayload }[] = []
      for (let j = i; j >= 0 && events[j].kind === 'question'; j -= 1) {
        const payload = events[j].payload as QuestionPayload & { answered?: boolean }
        if (answeredIds.includes(events[j].id) || payload?.answered || !payload?.options?.length) continue
        open.unshift({ eventId: events[j].id, payload })
      }
      return open
    }
    if (event.kind === 'assistant_text' || event.kind === 'summary') {
      if (answeredIds.includes(event.id)) return []
      const text = (event.payload as { text?: string }).text ?? ''
      const payload = parseInlineQuestion(text)
      return payload ? [{ eventId: event.id, payload }] : []
    }
  }
  return []
}
