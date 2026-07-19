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

// The instruction is prefixed with a hard directive so it is not diluted by the
// large Claude Code preset system prompt it is appended to.
const HEADER =
  '## MANDATORY OUTPUT STYLE — OVERRIDES DEFAULT VERBOSITY.\n' +
  'This instruction takes precedence over any default tendency to write at length. ' +
  'Apply it to EVERY response you produce for the rest of this session.\n'

const LEVEL_INSTRUCTIONS: Record<TerseLevel, string> = {
  lite:
    HEADER +
    'Level: LITE. Trim filler, pleasantries, hedging, and preamble. Lead with the conclusion. ' +
    'Prefer short sentences. Keep enough words to stay clear. ' +
    PRESERVE_CLAUSE,
  full:
    HEADER +
    'Level: TERSE. Write prose as compactly as possible while staying correct and unambiguous. ' +
    'Drop articles, filler, pleasantries, hedging, and any restating of the question. ' +
    'Strongly prefer sentence fragments and bullet points over full sentences. State the ' +
    'conclusion first, then only load-bearing detail. No preamble, no summary of what you did ' +
    'unless asked. ' +
    PRESERVE_CLAUSE,
  ultra:
    HEADER +
    'Level: ULTRA. Maximum prose compression. Telegraphic fragments only: no articles, no ' +
    'droppable pronouns, no filler, no restating the question, no preamble. One idea per line, ' +
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
