const MAX_QUOTED_LINES = 400

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
