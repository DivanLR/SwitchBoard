import type {
  FlowRepo,
  FlowReviewFinding,
  FlowRun,
  FlowStackId,
  FlowStage,
  FlowStageReport,
  Measured,
  VerifyReport,
} from '@shared/domain'
import { FLOW_STACK_LABELS } from '@shared/domain'
import { HONESTY } from '@main/verify/verify-dispatch'
import { FLOW_MARKER } from './flow-markers'
import { STACK_ORDER } from './stacks'

type Repo = Pick<FlowRepo, 'name' | 'path' | 'worktreePath' | 'stacks' | 'baseBranch'>

function where(repo: Repo): string {
  return `${repo.name} (${repo.worktreePath ?? repo.path})`
}

function stackNames(stacks: readonly string[]): string {
  return stacks.map((id) => FLOW_STACK_LABELS[id as FlowStackId] ?? id).join(' + ')
}

export function reposContext(repos: readonly Repo[]): string {
  if (repos.length < 2) return ''
  return [
    `This feature spans ${repos.length} repositories, each in its own worktree on the same branch:`,
    ...repos.map(
      (repo, at) =>
        `- ${where(repo)}${at === 0 ? ', the primary: the spec and tasks.md live here' : ''}; ${stackNames(repo.stacks)}; base ${repo.baseBranch}`,
    ),
  ].join('\n')
}

export function withRepos(text: string, repos: readonly Repo[]): string {
  const context = reposContext(repos)
  if (!context) return text
  return text.startsWith('/') ? `${text}\n\n${context}` : `${context}\n\n${text}`
}

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

export function planSteps(stacks: readonly string[], specDir: string | null, repos: readonly Repo[] = []): string[] {
  const feature = featureLine(specDir)
  const owner =
    repos.length > 1
      ? `Every task names the repository it belongs to, as ${repos.map((repo) => `[${repo.name}]`).join(' or ')} right after its id.`
      : ''
  return [
    `/speckit-plan ${args(feature, stackContext(stacks))}`.trim(),
    `/speckit-tasks ${args(feature, owner)}`.trim(),
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

function workIn(repos: readonly Repo[], stack: FlowStackId): string {
  if (repos.length < 2) return ''
  const mine = repos.filter((repo) => repo.stacks.includes(stack))
  return `Work in ${mine.map(where).join(' and ')}, on every unchecked task tasks.md gives ${mine.length === 1 ? 'that repository' : 'those repositories'}.`
}

export function buildSteps(stacks: readonly string[], specDir: string | null, repos: readonly Repo[] = []): string[] {
  const steps: string[] = []
  const dotnet = stacks.includes('dotnet')
  const context = args(UNATTENDED, featureLine(specDir), stackContext(stacks))
  if (dotnet) steps.push(`/speckit-implement-scaffold ${args(context, workIn(repos, 'dotnet'))}`)
  if (stacks.includes('angular')) {
    const rest = dotnet && repos.length < 2 ? 'Complete every task still unchecked in tasks.md.' : ''
    steps.push(`/speckit-implement ${args(rest, context, workIn(repos, 'angular'))}`)
  }
  return steps
}

export function buildHandshake(): string {
  return markerLine('build', ',"tasksDone":<checked task count or null>,"tasksTotal":<total task count or null>')
}

interface Scope {
  stacks: readonly string[]
  base: string
  name: string | null
}

function scopes(stacks: readonly string[], base: string, repos: readonly Repo[]): Scope[] {
  return repos.length > 1
    ? repos.map((repo) => ({ stacks: repo.stacks, base: repo.baseBranch, name: where(repo) }))
    : [{ stacks, base, name: null }]
}

export function cleanSteps(stacks: readonly string[], base: string, repos: readonly Repo[] = []): string[] {
  const steps: string[] = []
  const targets = scopes(stacks, base, repos)
  const multi = targets.length > 1
  for (const target of targets.filter((t) => t.stacks.includes('dotnet'))) {
    steps.push(
      `/dotnet-claude-kit:de-sloppify Only touch files${target.name ? ` in ${target.name}` : ''} changed on this branch against ${target.base}. ` +
        'Skip the step that creates issues: resolve or delete each TODO instead. Add no comments.',
    )
  }
  for (const target of targets) {
    steps.push(
      `/ponytail:ponytail-review Review the diff of ${target.name ? `${target.name} on this branch` : 'this branch'} against ${target.base}.`,
    )
  }
  const lint = multi
    ? 'Also run the lint script with --fix in each Angular repository that has one.'
    : "Also run the project's lint script with --fix if it has one."
  steps.push(
    args(
      `Apply every finding from ${multi ? 'those reviews' : 'that review'} that is safe, keeping behaviour the same. Add no comments.`,
      stacks.includes('angular') ? lint : '',
      multi
        ? 'Run the tests in each repository and keep them green, then commit the result in each one.'
        : 'Run the tests and keep them green, then commit the result.',
    ),
  )
  return steps
}

export function cleanHandshake(): string {
  return markerLine('clean')
}

const TEST_CONVENTIONS: Readonly<Record<FlowStackId, string>> = {
  dotnet:
    "match the repository's own test stack (its xUnit version, its assertion " +
    'library, NSubstitute) and dotnet-claude-kit:testing conventions; unit tests for every ' +
    'new handler, validator and service; integration tests through WebApplicationFactory ' +
    'when the repo already has an integration test project; architecture tests when present.',
  angular:
    "specs with the repo's runner (Karma/Jasmine), TestBed with standalone " +
    'imports, HttpTestingController for HTTP.',
}

export function testWritePrompt(
  run: Pick<FlowRun, 'specDir'>,
  stacks: readonly string[],
  repos: readonly Repo[] = [],
): string {
  const sections: string[] = []
  const multi = repos.length > 1
  for (const target of scopes(stacks, '', repos)) {
    for (const id of STACK_ORDER.filter((stack) => target.stacks.includes(stack))) {
      sections.push(`- ${target.name ? `${target.name}, ` : ''}${FLOW_STACK_LABELS[id]}: ${TEST_CONVENTIONS[id]}`)
    }
  }
  const postmanPath = run.specDir ? `${run.specDir}/postman/<slug>.postman_collection.json` : 'the spec folder'
  sections.push(
    `- API: if this feature adds or changes HTTP endpoints, write a Postman v2.1 collection at ` +
      `${postmanPath}${multi ? ` in ${repos[0].name}` : ''} with a {{baseUrl}} variable, one success and one failure request per ` +
      'endpoint, minimal request bodies.',
  )
  return [
    multi
      ? "Write the tests this feature is missing in each repository, with that repository's own conventions, then commit them in each one."
      : 'Write the tests this feature is missing, then commit them.',
    '',
    ...sections,
    '',
    HONESTY,
  ].join('\n')
}

export function reviewSteps(stacks: readonly string[], base: string, repos: readonly Repo[] = []): string[] {
  const steps: string[] = []
  for (const target of scopes(stacks, base, repos).filter((t) => t.stacks.includes('dotnet'))) {
    const scope = target.name ? `in ${target.name} ` : ''
    steps.push(`/dotnet-claude-kit:code-review Review the changes ${scope}on this branch against ${target.base}.`)
    steps.push(`/dotnet-claude-kit:security-scan Scope: the changes ${scope}on this branch against ${target.base}.`)
  }
  return steps
}

function againstBase(base: string, repos: readonly Repo[]): string {
  return repos.length > 1
    ? `in every repository, each against its own base (${repos.map((repo) => `${repo.name} against ${repo.baseBranch}`).join(', ')})`
    : `against ${base}`
}

export function reviewHandshake(
  base: string,
  specDir: string | null,
  stacks: readonly string[],
  repos: readonly Repo[] = [],
): string {
  const conventions = stackContext(stacks)
  const multi = repos.length > 1
  const lines = [
    `Review the changes on this branch ${againstBase(base, repos)}, if you have not already. Check them`,
    `against every acceptance criterion in ${specDir ? `${specDir}/spec.md` : "this feature's spec.md"}.`,
  ]
  if (multi) lines.push("Give each finding's file as <repository name>/<path inside that repository>.")
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
  run: Pick<FlowRun, 'baseBranch' | 'specDir'> & { repos?: readonly Repo[] },
): string {
  const mustFix = (report?.findings ?? []).filter((finding) => finding.severity === 'must_fix')
  const unmet = report?.unmet ?? []
  const lines = [
    `A review of the changes on this branch ${againstBase(run.baseBranch ?? 'the base branch', run.repos ?? [])} found the problems below.`,
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
  run: Pick<FlowRun, 'specDir' | 'prUrl' | 'baseBranch'> & { repos?: readonly Repo[] },
  stage: FlowStage,
  feedback: string,
): string {
  const path = artefactPathFor(run, stage)
  const lines = [`Revise ${REVISE_TARGET[stage]}${path ? ` (${path})` : ''} per this feedback:`, '', feedback.trim()]
  if (!path && run.specDir) lines.push('', `The feature's spec is ${run.specDir}/spec.md.`)
  if (stage !== 'spec' && stage !== 'plan') {
    lines.push(`Compare this branch ${againstBase(run.baseBranch ?? 'the base branch', run.repos ?? [])} to see what it changed so far.`)
  }
  return lines.join('\n')
}

const SHIP_FORBIDDEN_COMMANDS: readonly RegExp[] = [
  /\bgh\s+pr\s+(merge|review)\b/i,
  /\bgh\s+pr\s+edit\b.*--add-reviewer/i,
  /\bgh\s+api\b.*\/(merge|reviews|requested_reviewers)\b/i,
  /\baz\s+repos\s+pr\s+(update|set-vote|reviewer)\b/i,
]

const SHIP_REFUSAL =
  'The Ship stage raises the pull request and nothing more. Merging, approving, voting on or adding reviewers to it is left to a person.'

export function shipForbidden(toolName: string, input: unknown): string | null {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const command = typeof record.command === 'string' ? record.command : ''
  if (SHIP_FORBIDDEN_COMMANDS.some((pattern) => pattern.test(command))) return SHIP_REFUSAL
  if (!toolName.startsWith('mcp__')) return null
  if (/reviewer|vote|approve|merge/i.test(toolName)) return SHIP_REFUSAL
  if (/update_pull_request/i.test(toolName) && /"autoComplete"\s*:\s*true|"status"\s*:\s*"completed"/i.test(JSON.stringify(record))) {
    return SHIP_REFUSAL
  }
  return null
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

function workItemLink(run: Pick<FlowRun, 'source' | 'sourceRef'>): string {
  return run.source === 'ado' && run.sourceRef ? ` and link Azure DevOps work item ${run.sourceRef}.` : '.'
}

function shipEveryPrompt(
  run: Pick<FlowRun, 'title' | 'branch' | 'source' | 'sourceRef'>,
  test: { verify: VerifyReport | null; postman: string | null },
  repos: readonly Repo[],
): string {
  return [
    `Commit anything uncommitted in each repository, naming the feature "${run.title}". Push the branch` +
      `${run.branch ? ` (${run.branch})` : ''} in each one.`,
    'Raise one pull request per repository, each into its own base branch:',
    ...repos.map((repo) => `- ${where(repo)} into ${repo.baseBranch}`),
    'Before creating each one, look for an open pull request from this branch in that repository and report it',
    'instead of opening a second.',
    '',
    "Read each repository's own remote. For an Azure Repos remote (dev.azure.com or visualstudio.com), use the ado MCP server" +
      workItemLink(run),
    'For a GitHub remote, use gh pr create.',
    '',
    'Title each pull request after the feature. In each description: a short summary of the spec,',
    'what changed in that repository, the test report below, and the Postman collection path if one was written.',
    'Once every pull request exists, edit each description to link the others. Do not merge, approve, or add reviewers.',
    '',
    ...testReportLines(test.verify, test.postman),
    '',
    ADO_RULE,
    HONESTY,
    'Report only the pull request ids and urls the servers actually returned to you, one entry per repository, named exactly as the repository name before the brackets above.',
    '',
    markerLine(
      'ship',
      ',"pullRequests":[{"repository":"<repository name>","prUrl":"<browser url or null>","prId":"<id or null>"}]',
    ),
  ].join('\n')
}

export function shipPrompt(
  run: Pick<FlowRun, 'title' | 'branch' | 'baseBranch' | 'source' | 'sourceRef'>,
  test: { verify: VerifyReport | null; postman: string | null } = { verify: null, postman: null },
  repos: readonly Repo[] = [],
): string {
  if (repos.length > 1) return shipEveryPrompt(run, test, repos)
  return [
    `Commit anything uncommitted, naming the feature "${run.title}". Push the branch` +
      `${run.branch ? ` (${run.branch})` : ''}.`,
    'Before creating a pull request, look for an open one from this branch and report it instead',
    'of opening a second.',
    '',
    'For an Azure Repos remote (dev.azure.com or visualstudio.com), use the ado MCP server' + workItemLink(run),
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
