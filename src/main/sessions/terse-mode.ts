// Terse output mode: an authored (not third-party) system-prompt append that
// asks the model to compress the PROSE it writes back, reducing output tokens
// without altering the user's prompts or the context the model reads. Code,
// commands, paths, identifiers, configuration and error text are preserved
// byte-for-byte. Inspired by the caveman skill's premise; text is original.
import type { TerseLevel } from '@shared/domain'

const PRESERVE_CLAUSE =
  'Never abbreviate, reword, or omit code, shell commands, file paths, identifiers, ' +
  'configuration values, numeric results, or error messages. Reproduce all of those exactly. ' +
  'Never trade technical accuracy or a required step for brevity.'

const LEVEL_INSTRUCTIONS: Record<TerseLevel, string> = {
  lite:
    'OUTPUT STYLE (terse — lite). Trim filler, pleasantries, and hedging from your prose. ' +
    'Prefer short sentences and lead with the conclusion. Keep enough words to stay clear. ' +
    PRESERVE_CLAUSE,
  full:
    'OUTPUT STYLE (terse). Write your prose as compactly as possible while staying correct and ' +
    'unambiguous. Drop articles, filler, pleasantries, and hedging. Favour sentence fragments and ' +
    'bullet points over full sentences. State the conclusion first, then only load-bearing detail. ' +
    PRESERVE_CLAUSE,
  ultra:
    'OUTPUT STYLE (terse — ultra). Maximum compression of prose. Telegraphic fragments only: no ' +
    'articles, no pronouns where droppable, no filler, no restating the question. One idea per line, ' +
    'bullets over sentences, symbols/arrows where clearer than words. ' +
    PRESERVE_CLAUSE,
}

/** The append string for the given settings, or null when terse mode is off. */
export function terseSystemPromptAppend(options: {
  terseMode: boolean
  terseLevel: TerseLevel
}): string | null {
  if (!options.terseMode) return null
  return LEVEL_INSTRUCTIONS[options.terseLevel] ?? LEVEL_INSTRUCTIONS.full
}
