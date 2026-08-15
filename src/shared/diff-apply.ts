// What a review comment on a diff region is turned into before it is sent.
//
// The model of this feature is a pull-request comment, and the difference is the
// whole point: a comment describes what should change and waits for a human, and
// this carries it out. So the prompt has to be narrower than an ordinary request.
// It names one file, quotes one region, and forbids the two failure modes that
// make an applied comment worse than a written one — changing more than was
// pointed at, and answering with an opinion instead of an edit.

/** How much of a selection is quoted before it is truncated, in lines. */
const MAX_QUOTED_LINES = 400

/**
 * The instruction sent to the containerised session for one selected region.
 *
 * The region is quoted verbatim, markers and all, rather than described by line
 * numbers. Numbers are wrong as soon as anything above them moves, and the diff
 * the developer selected from is a snapshot that the session's own first edit
 * invalidates. The text is what they pointed at, and it is what the model is
 * best at finding again.
 *
 * The +/- markers are kept for the same reason they are shown: they say which
 * side of the change each line is on, so "revert this" and "keep this but rename
 * it" mean something. The prompt says explicitly that they are diff markers, or a
 * literal-minded reader inserts them into the file.
 */
export function applyToRegionPrompt(input: {
  path: string
  lines: readonly string[]
  instruction: string
}): string {
  const quoted = input.lines.slice(0, MAX_QUOTED_LINES)
  const truncated = input.lines.length - quoted.length

  return [
    `In ${input.path}, apply this to the region quoted below, and nothing else:`,
    '',
    input.instruction.trim(),
    '',
    'The region, as it appears in the diff. The leading +, - and space are DIFF',
    'MARKERS showing which side of the change each line is on. They are not part of',
    'the file and must not be written into it.',
    '',
    '```',
    ...quoted,
    ...(truncated > 0 ? [`… ${truncated} more selected line${truncated === 1 ? '' : 's'}`] : []),
    '```',
    '',
    // The three rules that make an applied comment safe to use. Each is here
    // because the alternative behaviour is what a general-purpose session does by
    // default, and each would cost the developer a review cycle to notice.
    'Rules for this edit:',
    `- Change only that region of ${input.path}. Do not tidy the rest of the file,`,
    '  do not reformat it, and do not touch another file unless the change cannot',
    '  compile without it — in which case say which file and why.',
    '- Locate the region by matching the text above, not by line number. If it no',
    '  longer matches, stop and say so rather than editing the closest thing.',
    '- Make the edit. Do not reply with a description of what could be done, and do',
    '  not open a plan for approval: this instruction is the approval.',
    '',
    'When you are done, reply with one short line naming what you changed.',
  ].join('\n')
}
