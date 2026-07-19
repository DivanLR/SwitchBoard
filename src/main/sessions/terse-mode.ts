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
// large Claude Code preset system prompt it is appended to. It is repeated at
// the end so it frames the response on both sides of the preset.
const HEADER =
  '## MANDATORY OUTPUT STYLE — THIS OVERRIDES DEFAULT VERBOSITY AND FORMATTING.\n' +
  'This is a hard constraint, not a preference. It takes precedence over any default ' +
  'tendency to write at length, add preamble, or restate the request. Apply it to EVERY ' +
  'response you produce for the rest of this session, including the very first one.\n'

const REINFORCE =
  '\nReminder: the output-style constraint above is mandatory for this and every later ' +
  'reply. If a reply reads like normal prose, it is too long — cut it.'

const LEVEL_INSTRUCTIONS: Record<TerseLevel, string> = {
  lite:
    HEADER +
    'Level: LITE. Trim filler, pleasantries, hedging, and preamble. Lead with the conclusion. ' +
    'Prefer short sentences. Keep enough words to stay clear. ' +
    PRESERVE_CLAUSE +
    REINFORCE,
  full:
    HEADER +
    'Level: TERSE (caveman). Compress prose hard. Telegraphic style: drop articles ' +
    '("the", "a", "an"), drop filler and hedging, drop pleasantries, never restate the ' +
    'question, no preamble, no closing summary unless asked. Use sentence fragments and ' +
    'bullet points, not full sentences. Conclusion first, then only load-bearing detail. ' +
    'Aim for well under half the words you would normally use. ' +
    PRESERVE_CLAUSE +
    REINFORCE,
  ultra:
    HEADER +
    'Level: ULTRA. Maximum prose compression. Telegraphic fragments only: no articles, no ' +
    'droppable pronouns, no filler, no restating the question, no preamble. One idea per line, ' +
    'bullets over sentences, symbols/arrows where clearer than words. ' +
    PRESERVE_CLAUSE +
    REINFORCE,
}

/** The append string for the given settings, or null when terse mode is off. */
export function terseSystemPromptAppend(options: {
  terseMode: boolean
  terseLevel: TerseLevel
}): string | null {
  if (!options.terseMode) return null
  return LEVEL_INSTRUCTIONS[options.terseLevel] ?? LEVEL_INSTRUCTIONS.full
}
