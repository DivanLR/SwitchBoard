import type { FlowItem, FlowRun, ScopedItem } from '@shared/domain'
import { HONESTY } from '@main/evals/verify-dispatch'
import { FLOW_MARKER } from './flow-markers'

const ADO_RULE =
  'Use the Azure DevOps MCP server for every DevOps read and write. Do not shell out to curl, ' +
  'az, or the REST API by hand, and do not invent an identifier you have not seen in a response.'

function markerLine(shape: string): string {
  return [
    `Finish your reply with one line, on its own, starting with ${FLOW_MARKER}: followed by JSON:`,
    '',
    shape,
    '',
    'Nothing after that line. No code fence around it.',
  ].join('\n')
}

export function featuresPrompt(query: string): string {
  const filter = query.trim()
  return [
    'List the Features I could work on next in Azure DevOps.',
    '',
    ADO_RULE,
    filter
      ? `Only Features matching: ${filter}`
      : 'Return the Features that are active or new, most recently changed first.',
    'At most 25. Read only: create nothing, update nothing.',
    '',
    HONESTY,
    '',
    markerLine(
      '{"kind":"features","features":[{"id":"<work item id>","title":"<title>","state":"<state>","url":"<browser url or null>"}]}',
    ),
  ].join('\n')
}

export function scopePrompt(input: { featureId: string; featureTitle: string }): string {
  return [
    `Scope Azure DevOps Feature ${input.featureId} — ${input.featureTitle} — into Product Backlog Items.`,
    '',
    ADO_RULE,
    `Read the Feature, its description, its existing child items and any linked wiki page, then read this repository to see how the work would actually be done.`,
    '',
    'Rules for the breakdown:',
    '- One PBI is one coherent change a single developer could take end to end.',
    '- Split by seam, not by layer. "Add the endpoint" and "add the UI for it" are one item if neither ships alone.',
    '- Do not invent work the Feature does not ask for, and say what you are deliberately leaving out.',
    '- If the Feature already has child items, list them and do not propose duplicates.',
    '- Acceptance lines are checkable statements, not restatements of the title.',
    '',
    'Create nothing in Azure DevOps. This is a proposal for the developer to approve.',
    'Do not call ExitPlanMode; the breakdown below is how you hand back.',
    '',
    HONESTY,
    '',
    markerLine(
      '{"kind":"scope","items":[{"localId":"<short slug>","title":"<title>","body":"<what and why, a short paragraph>","acceptance":["<checkable line>"],"estimate":"s|m|l"}],"risks":["<what could go wrong>"],"outOfScope":["<what you left out>"]}',
    ),
  ].join('\n')
}

export function crosscheckPrompt(input: {
  featureId: string
  featureTitle: string
  items: readonly ScopedItem[]
  round: number
}): string {
  const listed = input.items.map(
    (item, index) =>
      [
        `${index + 1}. ${item.title} (${item.localId}, ${item.estimate})`,
        `   ${item.body.replace(/\n/g, ' ')}`,
        `   acceptance: ${item.acceptance.join(' | ') || '(none)'}`,
      ].join('\n'),
  )
  return [
    `Review this proposed breakdown of Azure DevOps Feature ${input.featureId} — ${input.featureTitle}. Another session wrote it; you did not.`,
    '',
    'Read the repository and this feature for yourself before you judge it. Your job is to find what the breakdown got wrong, not to agree with it.',
    '',
    ...listed,
    '',
    'Check it against, in this order:',
    "- The repository's own CLAUDE.md and conventions.",
    '- Whether each item could actually ship alone, or is really half of another item.',
    '- Work the feature asks for that no item covers.',
    '- Work no item should be doing, that belongs to another feature.',
    '- Acceptance lines that cannot be checked.',
    '',
    'Change nothing, in the repository or in Azure DevOps.',
    'Do not call ExitPlanMode; the sign-off below is how you hand back.',
    input.round > 0
      ? `This is review round ${input.round + 1}. The other session has already had your earlier concerns; say whether they were addressed.`
      : '',
    '',
    'Approve when the breakdown is workable, even if you would have written it differently. Ask for a revision only for something that would cost real work to get wrong.',
    'When you ask for a revision, you may supply a corrected list of items in the same shape; leave items null if your concerns say enough.',
    '',
    HONESTY,
    '',
    markerLine(
      '{"kind":"signoff","verdict":"approve|revise","concerns":["<what is wrong, one per line>"],"items":null}',
    ),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function reviseScopePrompt(concerns: readonly string[]): string {
  return [
    'A second session reviewed your breakdown and asked for a revision. Its concerns:',
    '',
    ...concerns.map((concern) => `- ${concern}`),
    '',
    'Answer each one: either change the breakdown, or say plainly why the concern is wrong and leave that part as it was. Do not simply agree.',
    'Create nothing in Azure DevOps.',
    '',
    markerLine(
      '{"kind":"scope","items":[{"localId":"<short slug>","title":"<title>","body":"<what and why>","acceptance":["<checkable line>"],"estimate":"s|m|l"}],"risks":["<risk>"],"outOfScope":["<left out>"]}',
    ),
  ].join('\n')
}

export function lessonsPrompt(input: {
  run: FlowRun
  items: readonly FlowItem[]
  rejected: readonly string[]
}): string {
  const prs = input.items
    .filter((item) => item.prId)
    .map((item) => `- work item ${item.workItemId}, pull request ${item.prId}: ${item.title}`)
  return [
    `Read the review comments on the pull requests this feature produced, and turn what the reviewer asked for into standing rules.`,
    '',
    ADO_RULE,
    'Pull requests:',
    ...(prs.length > 0 ? prs : ['- (none were raised)']),
    '',
    'For each pull request, read every comment thread, including resolved ones. Ignore your own or any bot comments; you are looking for what a human reviewer asked to be different.',
    '',
    'Turn only repeated or clearly general feedback into a rule. A rule is:',
    '- One sentence, in the imperative, that a future session could follow without seeing this PR.',
    '- Specific to this codebase, not generic advice.',
    '- Backed by at least one real comment, quoted.',
    '',
    'Do not invent a rule from a comment you did not read, and do not restate a rule that CLAUDE.md already has.',
    input.rejected.length > 0
      ? `These rules were proposed before and rejected by the developer. Do not propose them again:\n${input.rejected.map((rule) => `- ${rule}`).join('\n')}`
      : '',
    '',
    'Change nothing. Do not edit CLAUDE.md yourself.',
    '',
    HONESTY,
    'Every rule must carry the comment it came from, quoted exactly.',
    '',
    markerLine(
      '{"kind":"lessons","lessons":[{"rule":"<one sentence>","section":"<CLAUDE.md heading it belongs under, or null>","evidence":[{"prId":"<id>","author":"<who said it, or null>","quote":"<their words>"}]}],"note":"<what you could not read, or null>"}',
    ),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function implementPrompt(input: {
  run: FlowRun
  item: FlowItem
  branch: string
  resumed: boolean
}): string {
  const acceptance =
    input.item.acceptance.length > 0
      ? input.item.acceptance.map((line) => `- ${line}`)
      : ['- (none were written; infer them from the item body and say what you assumed)']
  return [
    input.resumed
      ? 'Your previous session on this work item ended before it finished. Read the working tree first: some of the work may already be done, and some may be half done. Do not start again from nothing.'
      : `Implement Azure DevOps work item ${input.item.workItemId} — ${input.item.title}.`,
    '',
    `You are in a git worktree of this repository on branch ${input.branch}. Everything you change here is isolated from the main checkout and from the other work items running beside you.`,
    '',
    input.item.body,
    '',
    'Acceptance:',
    ...acceptance,
    '',
    'Rules for this work:',
    '- Stay inside this work item. If you find something else that is broken, say so, do not fix it.',
    "- Follow the repository's own conventions and its CLAUDE.md. Read before you write.",
    '- Run whatever checks this repository has for what you changed, and make them pass.',
    '- Commit your work on this branch with a message that names the work item. Do not push, and do not open a pull request; that is a separate step.',
    '- If you cannot finish because something outside this work item blocks you, stop and report it as blocked rather than working around it.',
    '',
    HONESTY,
    '',
    markerLine(
      `{"kind":"item","workItemId":"${input.item.workItemId}","outcome":"done|blocked","summary":"<one line on what you changed>","why":"<what blocked you, or null>"}`,
    ),
  ].join('\n')
}

export function prPrompt(input: {
  run: FlowRun
  item: FlowItem
  branch: string
  baseBranch: string
}): string {
  return [
    `Raise a pull request in Azure Repos for work item ${input.item.workItemId} — ${input.item.title}.`,
    '',
    ADO_RULE,
    `The work is committed on branch ${input.branch} in this worktree. Push that branch, then open a pull request into ${input.baseBranch}.`,
    'Before creating one, list the open pull requests for this branch. If one already exists, report it rather than opening a second.',
    'Link the pull request to the work item. Title it after the work item. In the description, say what changed and how it was checked.',
    'Do not complete, approve or merge the pull request, and do not add reviewers.',
    '',
    HONESTY,
    'Report only the pull request id Azure DevOps actually returned to you.',
    '',
    markerLine(
      `{"kind":"pr","workItemId":"${input.item.workItemId}","prId":"<id>","url":"<browser url or null>","branch":"${input.branch}"}`,
    ),
  ].join('\n')
}

export function publishPrompt(input: { run: FlowRun; items: readonly FlowItem[] }): string {
  const lines = input.items.map(
    (item, index) =>
      [
        `${index + 1}. localId: ${item.localId}`,
        `   title: ${item.title}`,
        `   body: ${item.body.replace(/\n/g, ' ')}`,
        `   acceptance: ${item.acceptance.join(' | ') || '(none)'}`,
      ].join('\n'),
  )
  return [
    `Create these Product Backlog Items in Azure DevOps as children of Feature ${input.run.featureId} (${input.run.featureTitle}).`,
    '',
    ADO_RULE,
    'Before creating anything, list the existing children of that Feature. If one already has the same title, do not create a second — report its id as the created id for that localId and say so.',
    'Create them in the order given, in the same area and iteration path as the Feature.',
    'Put the acceptance lines in the item description. Do not assign anyone, and do not set a state other than the default.',
    '',
    ...lines,
    '',
    HONESTY,
    'Report only ids Azure DevOps actually returned to you.',
    '',
    markerLine(
      '{"kind":"published","created":[{"localId":"<localId>","workItemId":"<new id>","url":"<browser url or null>"}],"failed":[{"localId":"<localId>","why":"<what stopped it>"}]}',
    ),
  ].join('\n')
}
