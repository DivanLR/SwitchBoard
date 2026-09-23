import type { FlowReviewFinding, FlowRun, FlowStage, FlowStageReport, Measured, VerifyReport } from '@shared/domain'
import { HONESTY } from '@main/evals/verify-dispatch'
import { FLOW_MARKER } from './flow-markers'

export const ADO_RULE =
  'Use the Azure DevOps MCP server for every DevOps read and write. Do not shell out to curl, ' +
  'az, or the REST API by hand, and do not invent an identifier you have not seen in a response.'

function markerLine(stage: FlowStage, extra = ''): string {
  return [
    `Finish your reply with one line, on its own, starting with ${FLOW_MARKER}: followed by JSON:`,
    '',
    `{"kind":"stage","stage":"${stage}","outcome":"done|blocked","summary":"<one line on what you did>","why":"<what blocked you, or null>"${extra}}`,
    '',
    'Nothing after that line. No code fence around it.',
    '',
    HONESTY,
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
    `Finish your reply with one line, on its own, starting with ${FLOW_MARKER}: followed by JSON:`,
    '',
    '{"kind":"features","features":[{"id":"<work item id>","title":"<title>","state":"<state>","url":"<browser url or null>"}]}',
    '',
    'Nothing after that line. No code fence around it.',
  ].join('\n')
}

export function specDescription(run: Pick<FlowRun, 'source' | 'sourceRef' | 'sourceUrl' | 'title' | 'description'>): string {
  if (run.source === 'ado') {
    return [
      `Azure DevOps Feature ${run.sourceRef}: ${run.title}. Read it with the ado MCP server`,
      '(description, acceptance criteria, child items, linked wiki) and specify exactly that.',
      run.sourceUrl ?? '',
    ]
      .filter((line) => line !== '')
      .join('\n')
  }
  return run.description ? `${run.title}: ${run.description}` : run.title
}

const ASK_ME =
  'Ask me each clarification question through the AskUserQuestion tool, with its options and ' +
  'your recommended option first, and wait for my answer before you go on.'

const ANSWER_YOURSELF =
  'Answer each question yourself with your recommended option, record the answer in the spec, and do not wait for me.'

export function specifyPrompt(
  run: Pick<FlowRun, 'source' | 'sourceRef' | 'sourceUrl' | 'title' | 'description' | 'autopilot'>,
): string {
  return [
    `/speckit-specify ${specDescription(run)}`,
    run.autopilot ? ANSWER_YOURSELF : ASK_ME,
    run.source === 'ado' ? ADO_RULE : '',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function clarifyPrompt(autopilot: boolean): string {
  return `/speckit-clarify ${autopilot ? ANSWER_YOURSELF : ASK_ME}`
}

export function specHandshake(): string {
  return markerLine('spec', ',"specDir":"<specs/NNN-slug, the folder .specify/feature.json or the newest specs folder names>"')
}

function featureLine(specDir: string | null): string {
  return specDir ? `The feature is ${specDir}; its spec is ${specDir}/spec.md.` : ''
}

function args(...parts: string[]): string {
  return parts.filter((part) => part !== '').join(' ')
}

export function stackContext(stacks: readonly string[]): string {
  const parts: string[] = []
  if (stacks.includes('dotnet')) {
    parts.push(
      ".NET: follow this repository's own architecture and CLAUDE.md; options pattern for every " +
        'configuration read (IOptionsMonitor for feature flags); the project\'s own Result<T>, ' +
        'never a third-party result library; correlation id header on new endpoints; sealed ' +
        'classes; no comments.',
    )
  }
  if (stacks.includes('angular')) {
    parts.push(
      "Angular: follow this repository's own structure; standalone components; signals; " +
        'OnPush; typed reactive forms; inject(); Karma/Jasmine specs; no any; no comments.',
    )
  }
  return parts.join(' ')
}

export function planSteps(stacks: readonly string[], specDir: string | null): string[] {
  const feature = featureLine(specDir)
  return [
    `/speckit-plan ${args(feature, stackContext(stacks))}`.trim(),
    `/speckit-tasks ${feature}`.trim(),
    `/speckit-analyze ${feature}`.trim(),
  ]
}

export function planHandshake(): string {
  return [
    markerLine('plan', ',"tasksDone":<checked task count or null>,"tasksTotal":<total task count or null>'),
    '',
    'If /speckit-analyze reported any CRITICAL issue, the outcome is blocked and why lists every CRITICAL issue.',
  ].join('\n')
}

const UNATTENDED =
  'This run is unattended: if a checklist is incomplete, proceed and list the open items in your report; ' +
  'if the architecture is ambiguous, use the one plan.md names. Report how many tasks are done and the total.'

export function buildSteps(stacks: readonly string[], specDir: string | null): string[] {
  const steps: string[] = []
  const dotnet = stacks.includes('dotnet')
  const context = args(UNATTENDED, featureLine(specDir), stackContext(stacks))
  if (dotnet) steps.push(`/speckit-implement-scaffold ${context}`)
  if (stacks.includes('angular')) {
    steps.push(`/speckit-implement ${args(dotnet ? 'Complete every task still unchecked in tasks.md.' : '', context)}`)
  }
  return steps
}

export function buildHandshake(): string {
  return markerLine('build', ',"tasksDone":<checked task count or null>,"tasksTotal":<total task count or null>')
}

export function cleanSteps(stacks: readonly string[], base: string): string[] {
  const steps: string[] = []
  if (stacks.includes('dotnet')) {
    steps.push(
      `/dotnet-claude-kit:de-sloppify Only touch files changed on this branch against ${base}. ` +
        'Skip the step that creates issues: resolve or delete each TODO instead. Add no comments.',
    )
  }
  steps.push(`/ponytail:ponytail-review Review the diff of this branch against ${base}.`)
  steps.push(
    args(
      'Apply every finding from that review that is safe, keeping behaviour the same. Add no comments.',
      stacks.includes('angular') ? "Also run the project's lint script with --fix if it has one." : '',
      'Run the tests and keep them green, then commit the result.',
    ),
  )
  return steps
}

export function cleanHandshake(): string {
  return markerLine('clean')
}

export function testWritePrompt(run: Pick<FlowRun, 'specDir'>, stacks: readonly string[]): string {
  const sections: string[] = []
  if (stacks.includes('dotnet')) {
    sections.push(
      "- .NET: match the repository's own test stack (its xUnit version, its assertion " +
        'library, NSubstitute) and dotnet-claude-kit:testing conventions; unit tests for every ' +
        'new handler, validator and service; integration tests through WebApplicationFactory ' +
        'when the repo already has an integration test project; architecture tests when present.',
    )
  }
  if (stacks.includes('angular')) {
    sections.push(
      "- Angular: specs with the repo's runner (Karma/Jasmine), TestBed with standalone " +
        'imports, HttpTestingController for HTTP.',
    )
  }
  const postmanPath = run.specDir ? `${run.specDir}/postman/<slug>.postman_collection.json` : 'the spec folder'
  sections.push(
    `- API: if this feature adds or changes HTTP endpoints, write a Postman v2.1 collection at ` +
      `${postmanPath} with a {{baseUrl}} variable, one success and one failure request per ` +
      'endpoint, minimal request bodies.',
  )
  return [
    'Write the tests this feature is missing, then commit them.',
    '',
    ...sections,
    '',
    HONESTY,
  ].join('\n')
}

export function reviewSteps(stacks: readonly string[], base: string): string[] {
  const steps: string[] = []
  if (stacks.includes('dotnet')) {
    steps.push(`/dotnet-claude-kit:code-review Review the changes on this branch against ${base}.`)
    steps.push(`/dotnet-claude-kit:security-scan Scope: the changes on this branch against ${base}.`)
  }
  return steps
}

export function reviewHandshake(base: string, specDir: string | null, stacks: readonly string[]): string {
  const conventions = stackContext(stacks)
  const lines = [
    `Review the changes on this branch against ${base}, if you have not already. Check them`,
    `against every acceptance criterion in ${specDir ? `${specDir}/spec.md` : "this feature's spec.md"}.`,
  ]
  if (conventions) {
    lines.push(`Check them against these conventions too; every violation is a must_fix finding: ${conventions}`)
  }
  lines.push(
    'Every Critical or High security finding is a must_fix finding.',
    '',
    markerLine(
      'review',
      ',"verdict":"ready|needs_fixes","findings":[{"severity":"must_fix|should_fix|nit","file":"<path or null>","line":<line or null>,"what":"<what is wrong>"}],"unmet":["<acceptance criterion the code does not meet>"]',
    ),
    '',
    'The outcome is done whenever you completed the review, whatever it found; blocked only means the review itself could not run.',
    'needs_fixes when any must_fix finding or any unmet criterion exists, ready otherwise.',
  )
  return lines.join('\n')
}

function findingLine(finding: FlowReviewFinding): string {
  const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}: ` : ''
  return `- ${where}${finding.what}`
}

export function fixFindingsPrompt(
  report: Pick<FlowStageReport, 'findings' | 'unmet'> | null,
  run: Pick<FlowRun, 'baseBranch' | 'specDir'>,
): string {
  const mustFix = (report?.findings ?? []).filter((finding) => finding.severity === 'must_fix')
  const unmet = report?.unmet ?? []
  const lines = [
    `A review of the changes on this branch against ${run.baseBranch ?? 'the base branch'} found the problems below.`,
    'Fix every must_fix finding and every unmet acceptance criterion listed here, keep the tests green, and commit.',
  ]
  if (run.specDir) lines.push(`The acceptance criteria are in ${run.specDir}/spec.md.`)
  if (mustFix.length > 0) lines.push('', 'Must fix:', ...mustFix.map(findingLine))
  if (unmet.length > 0) lines.push('', 'Unmet acceptance criteria:', ...unmet.map((line) => `- ${line}`))
  return lines.join('\n')
}

const REVISE_TARGET: Record<FlowStage, string> = {
  spec: 'the spec',
  plan: 'the plan and its tasks',
  build: 'the implementation on this branch',
  clean: 'the cleanup on this branch',
  test: 'the tests on this branch',
  review: 'the review of this branch',
  ship: 'the pull request for this branch',
}

export function artefactPathFor(run: Pick<FlowRun, 'specDir' | 'prUrl'>, stage: FlowStage): string | null {
  if (stage === 'ship') return run.prUrl
  if (!run.specDir) return null
  if (stage === 'spec') return `${run.specDir}/spec.md`
  if (stage === 'plan') return `${run.specDir}/plan.md`
  return null
}

export function revisePrompt(
  run: Pick<FlowRun, 'specDir' | 'prUrl' | 'baseBranch'>,
  stage: FlowStage,
  feedback: string,
): string {
  const path = artefactPathFor(run, stage)
  const lines = [`Revise ${REVISE_TARGET[stage]}${path ? ` (${path})` : ''} per this feedback:`, '', feedback.trim()]
  if (!path && run.specDir) lines.push('', `The feature's spec is ${run.specDir}/spec.md.`)
  if (stage !== 'spec' && stage !== 'plan') {
    lines.push(`Compare this branch against ${run.baseBranch ?? 'the base branch'} to see what it changed so far.`)
  }
  return lines.join('\n')
}

function measured(label: string, value: Measured): string[] {
  return value.value === null ? [] : [`- ${label}: ${value.value}%${value.source ? ` (${value.source})` : ''}`]
}

export function testReportLines(verify: VerifyReport | null, postman: string | null): string[] {
  const lines = verify
    ? [
        'The Test stage reported this. Quote these figures as they are and add none of your own:',
        ...verify.suites.map((suite) => `- ${suite.id} (${suite.label}): ${suite.status}${suite.detail ? `, ${suite.detail}` : ''}`),
        ...measured('Line coverage', verify.coverage.line),
        ...measured('Changed-line coverage', verify.coverage.changed),
      ]
    : ['The Test stage left no report, so say that in the description instead of giving figures.']
  lines.push(postman ? `Postman collection: ${postman}` : 'No Postman collection was written.')
  return lines
}

export function shipPrompt(
  run: Pick<FlowRun, 'title' | 'branch' | 'baseBranch' | 'source' | 'sourceRef'>,
  test: { verify: VerifyReport | null; postman: string | null } = { verify: null, postman: null },
): string {
  return [
    `Commit anything uncommitted, naming the feature "${run.title}". Push the branch` +
      `${run.branch ? ` (${run.branch})` : ''}.`,
    'Before creating a pull request, look for an open one from this branch and report it instead',
    'of opening a second.',
    '',
    'For an Azure Repos remote (dev.azure.com or visualstudio.com), use the ado MCP server' +
      (run.source === 'ado' && run.sourceRef
        ? ` and link Azure DevOps work item ${run.sourceRef}.`
        : '.'),
    'For a GitHub remote, use gh pr create.',
    '',
    `Title the pull request after the feature. In the description: a short summary of the spec,`,
    'what changed, the test report below, and the Postman collection path if one was written.',
    `Base it on ${run.baseBranch ?? 'the base branch'}. Do not merge, approve, or add reviewers.`,
    '',
    ...testReportLines(test.verify, test.postman),
    '',
    ADO_RULE,
    HONESTY,
    'Report only the pull request id and url the server actually returned to you.',
    '',
    markerLine('ship', ',"prUrl":"<browser url or null>","prId":"<id or null>"'),
  ].join('\n')
}
