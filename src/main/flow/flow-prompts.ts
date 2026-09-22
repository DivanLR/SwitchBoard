import type { FlowRun, FlowStage } from '@shared/domain'
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

export function specifyPrompt(run: Pick<FlowRun, 'source' | 'sourceRef' | 'sourceUrl' | 'title' | 'description'>): string {
  const base = `/speckit-specify ${specDescription(run)}`
  return run.source === 'ado' ? [ADO_RULE, '', base].join('\n') : base
}

export function clarifyPrompt(autopilot: boolean): string {
  return autopilot
    ? '/speckit-clarify Answer each question yourself with your recommended option, record the answer in the spec, and do not wait for me.'
    : '/speckit-clarify'
}

export function specHandshake(): string {
  return markerLine('spec', ',"specDir":"<specs/NNN-slug, the folder .specify/feature.json or the newest specs folder names>"')
}

function stackContext(stacks: readonly string[]): string {
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

export function planPrompt(stacks: readonly string[]): string {
  return `/speckit-plan ${stackContext(stacks)}`
}

export const TASKS_PROMPT = '/speckit-tasks'
export const ANALYZE_PROMPT = '/speckit-analyze'

export function planHandshake(): string {
  return markerLine('plan', ',"tasksDone":<checked task count or null>,"tasksTotal":<total task count or null>')
}

export function buildSteps(stacks: readonly string[]): string[] {
  const steps: string[] = []
  const dotnet = stacks.includes('dotnet')
  const angular = stacks.includes('angular')
  if (dotnet) steps.push('/speckit-implement-scaffold')
  if (angular) {
    steps.push(dotnet ? '/speckit-implement Complete every task still unchecked in tasks.md.' : '/speckit-implement')
  }
  return steps
}

export function buildHandshake(): string {
  return markerLine('build', ',"tasksDone":<checked task count or null>,"tasksTotal":<total task count or null>')
}

export function cleanSteps(stacks: readonly string[], base: string): string[] {
  const steps: string[] = []
  if (stacks.includes('dotnet')) {
    steps.push(`/dotnet-claude-kit:de-sloppify Only touch files changed on this branch against ${base}.`)
  }
  const ponytail = [
    `/ponytail:ponytail-review Review the diff of this branch against ${base} and apply every`,
    'finding that is safe. Keep behaviour and tests green. Commit the result.',
    stacks.includes('angular')
      ? " Also run the project's lint script with --fix if it has one."
      : '',
  ].join(' ')
  steps.push(ponytail.trim())
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

export function reviewHandshake(base: string): string {
  return [
    `Review the changes on this branch against ${base}, if you have not already. Check them`,
    "against every acceptance criterion in this feature's spec.md.",
    '',
    markerLine(
      'review',
      ',"verdict":"ready|needs_fixes","findings":[{"severity":"must_fix|should_fix|nit","file":"<path or null>","line":<line or null>,"what":"<what is wrong>"}],"unmet":["<acceptance criterion the code does not meet>"]',
    ),
    '',
    'needs_fixes when any must_fix finding or any unmet criterion exists, ready otherwise.',
  ].join('\n')
}

export function fixFindingsPrompt(): string {
  return 'Fix every must_fix finding and every unmet acceptance criterion above, keep tests green, commit.'
}

export function revisePrompt(artefact: string, feedback: string): string {
  return `Revise ${artefact} per this feedback: ${feedback}`
}

export function shipPrompt(run: Pick<FlowRun, 'title' | 'branch' | 'baseBranch' | 'source' | 'sourceRef'>): string {
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
    'what changed, the test report gates, and the Postman collection path if one was written.',
    `Base it on ${run.baseBranch ?? 'the base branch'}. Do not merge, approve, or add reviewers.`,
    '',
    ADO_RULE,
    HONESTY,
    'Report only the pull request id and url the server actually returned to you.',
    '',
    markerLine('ship', ',"prUrl":"<browser url or null>","prId":"<id or null>"'),
  ].join('\n')
}
