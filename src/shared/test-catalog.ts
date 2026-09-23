type SuiteKind = 'api' | 'unit' | 'ui' | 'coverage' | 'quality' | 'mutation'

export type SuiteTool = 'dotnet' | 'node' | 'browser'

export interface TestSuite {
  id: string
  kind: SuiteKind
  label: string
  acceptance: string
  command: string
  needs: SuiteTool
  mcp?: string
  heavy?: boolean
}

interface TestStack {
  id: string
  label: string
  detect: readonly string[]
  suites: readonly TestSuite[]
}

export const TEST_STACKS: readonly TestStack[] = [
  {
    id: 'dotnet',
    label: '.NET',
    detect: ['*.sln', '*.slnx', 'Directory.Build.props', 'global.json'],
    suites: [
      {
        id: 'dotnet-unit',
        kind: 'unit',
        label: 'Unit tests',
        acceptance: 'the solution builds and every unit test passes',
        command: 'dotnet test --nologo --logger trx',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-coverage',
        kind: 'coverage',
        label: 'Coverage',
        acceptance: 'the changed code is covered by tests',
        command: 'dotnet test --nologo --logger trx --collect:"XPlat Code Coverage"',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-api',
        kind: 'api',
        label: 'API integration tests',
        acceptance: 'every endpoint answers as its contract says (status, shape, auth)',
        command: 'dotnet test --nologo --logger trx --filter Category=Integration',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-http',
        kind: 'api',
        label: 'HTTP smoke (real endpoints)',
        acceptance:
          'the running API answers real requests correctly, checked against real rows',
        command:
          "start the API, take real identifiers from the project's database MCP server, call the endpoints with them (plus the project's .http file if present), and check each response back against the data",
        needs: 'dotnet',
      },
      {
        id: 'dotnet-arch',
        kind: 'quality',
        label: 'Architecture rules',
        acceptance: 'no layer depends on something it may not depend on',
        command: 'dotnet test --nologo --logger trx --filter Category=Architecture',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-format',
        kind: 'quality',
        label: 'Format and analyzers',
        acceptance: 'formatting and analyzer rules are clean',
        command: 'dotnet format --verify-no-changes && dotnet build --nologo -warnaserror',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-sonar',
        kind: 'quality',
        label: 'SonarQube gate',
        acceptance: 'the code-quality gate passes on this branch',
        command:
          'Read the quality gate, duplication, technical debt and open issue counts for this ' +
          'project through the SonarQube MCP server, and name the server as the source. If the ' +
          'gate has never been computed for this branch, say so — do not report the main branch ' +
          "figures as though they were this branch's.",
        needs: 'dotnet',
        mcp: 'sonarqube',
      },
      {
        id: 'dotnet-roslyn',
        kind: 'quality',
        label: 'Roslyn analysis',
        acceptance: 'no compiler diagnostics, dead code or circular dependencies were introduced',
        command:
          'Through the Roslyn navigator MCP server: get diagnostics for the solution, detect ' +
          'anti-patterns and circular dependencies, and find dead code. Report errors and ' +
          'warnings separately, and count only what this working tree introduced — compare ' +
          'against the diff rather than reporting the solution\'s whole backlog as a failure.',
        needs: 'dotnet',
        mcp: 'roslyn-navigator',
      },
      {
        id: 'dotnet-mutation',
        kind: 'mutation',
        label: 'Mutation testing (Stryker)',
        acceptance: 'the tests fail when the code is broken on purpose',
        command: 'dotnet stryker',
        needs: 'dotnet',
        heavy: true,
      },
    ],
  },
  {
    id: 'angular',
    label: 'Angular',
    detect: ['angular.json'],
    suites: [
      {
        id: 'ng-unit',
        kind: 'unit',
        label: 'Unit tests (Karma/Jasmine)',
        acceptance: 'every component and service spec passes',
        command: 'npx ng test --watch=false --browsers=ChromeHeadless',
        needs: 'browser',
      },
      {
        id: 'ng-coverage',
        kind: 'coverage',
        label: 'Coverage',
        acceptance: 'the changed components are covered',
        command: 'npx ng test --watch=false --code-coverage --browsers=ChromeHeadless',
        needs: 'browser',
      },
      {
        id: 'ng-build',
        kind: 'quality',
        label: 'Production build',
        acceptance: 'the production build succeeds with no new warnings',
        command: 'npx ng build',
        needs: 'node',
      },
      {
        id: 'ng-lint',
        kind: 'quality',
        label: 'Lint',
        acceptance: 'lint is clean',
        command: 'npx ng lint',
        needs: 'node',
      },
      {
        id: 'ng-e2e',
        kind: 'ui',
        label: 'UI end-to-end',
        acceptance: 'the affected screens work end to end in a real browser',
        command: 'npx playwright test',
        needs: 'browser',
      },
    ],
  },
]

export function sandboxNeedsDotnet(stacks: readonly AvailableSuites[]): boolean {
  return stacks.some((s) => s.stackId === 'dotnet')
}

export function sandboxTools(dotnet: boolean, browser = false): readonly SuiteTool[] {
  const tools: SuiteTool[] = ['node']
  if (dotnet) tools.push('dotnet')
  if (browser) tools.push('browser')
  return tools
}

export function needsBrowser(
  entries: readonly string[],
  read?: (entry: string) => string | null,
): boolean {
  const lower = entries.map((entry) => entry.replace(/\\/g, '/').toLowerCase())
  const named = lower.some(
    (entry) =>
      /(^|\/)playwright[.-]?[a-z0-9.-]*\.(config|conf)\.(ts|js|mjs|cjs)$/.test(entry) ||
      /(^|\/)karma\.conf\.(js|ts)$/.test(entry) ||
      /(^|\/)angular\.json$/.test(entry) ||
      /(^|\/)(cypress|wdio)\.config\.(ts|js|mjs|cjs)$/.test(entry),
  )
  if (named || !read) return named
  for (const entry of entries.filter((e) => /(^|[\\/])package\.json$/i.test(e)).slice(0, 8)) {
    const text = read(entry)
    if (text && /"@playwright\/test"|"playwright"|"karma"|"cypress"/.test(text)) return true
  }
  return false
}

export type SandboxEnv = readonly SuiteTool[] | null

export function unavailableReason(suite: TestSuite, sandbox: SandboxEnv): string | null {
  if (!sandbox || sandbox.includes(suite.needs)) return null
  return `${suite.needs} is not in the bypass container`
}

export function defaultSelection(suites: readonly TestSuite[], sandbox: SandboxEnv = null): string[] {
  return suites.filter((s) => !s.heavy && !unavailableReason(s, sandbox)).map((s) => s.id)
}

export interface VerifyGate {
  id: 'unit' | 'integration' | 'architecture' | 'mutation' | 'coverage' | 'quality-service'
  name: string
  panel: 'coverage' | 'quality' | 'evidence'
  target: string
}

export const VERIFY_GATES: readonly VerifyGate[] = [
  { id: 'unit', name: 'UNIT', panel: 'evidence', target: 'all pass' },
  { id: 'integration', name: 'INTEGRATION', panel: 'evidence', target: 'all pass' },
  { id: 'architecture', name: 'ARCHITECTURE', panel: 'quality', target: '0 violations' },
  { id: 'mutation', name: 'MUTATION', panel: 'quality', target: '≥ 70%' },
  { id: 'coverage', name: 'COVERAGE', panel: 'coverage', target: '≥ 80% line · ≥ 90% changed' },
  { id: 'quality-service', name: 'CODE QUALITY', panel: 'quality', target: 'gate passes · ≤ 3% duplication' },
]

export function stackById(id: string | undefined): TestStack | null {
  return TEST_STACKS.find((s) => s.id === id) ?? null
}

export function suiteById(id: string): TestSuite | null {
  for (const stack of TEST_STACKS) {
    const found = stack.suites.find((s) => s.id === id)
    if (found) return found
  }
  return null
}

export interface AvailableSuites {
  stackId: string
  stackLabel: string
  suites: readonly TestSuite[]
}

function detectApi(
  entries: readonly string[],
  read: (entry: string) => string | null,
): boolean {
  const MAX_READS = 12
  const lower = entries.map((entry) => entry.replace(/\\/g, '/').toLowerCase())
  let api = lower.some(
    (entry) => entry.endsWith('.http') || entry === 'controllers' || entry.includes('controllers/'),
  )

  const readable = entries.filter((entry) => {
    const name = entry.replace(/\\/g, '/').toLowerCase()
    return name.endsWith('.csproj') || name.endsWith('program.cs') || name.endsWith('startup.cs')
  })
  for (const entry of readable.slice(0, MAX_READS)) {
    if (api) break
    const text = read(entry)
    if (!text) continue
    if (/MapControllers|AddControllers|MapOpenApi|AddOpenApi|AddSwaggerGen/.test(text)) api = true
  }

  return api
}

function angularHasLintTarget(
  entries: readonly string[],
  read: (entry: string) => string | null,
): boolean {
  for (const entry of entries.filter((e) => /(^|[\\/])angular\.json$/i.test(e)).slice(0, 4)) {
    const text = read(entry)
    if (text && /"lint"\s*:/.test(text)) return true
  }
  return false
}

function angularHasE2e(
  entries: readonly string[],
  read: (entry: string) => string | null,
): boolean {
  for (const entry of entries.filter((e) => /(^|[\\/])package\.json$/i.test(e)).slice(0, 8)) {
    const text = read(entry)
    if (text && /"(@playwright\/test|cypress)"\s*:/.test(text)) return true
  }
  return false
}

function suitesFor(
  stack: TestStack,
  angularLint: boolean,
  angularE2e: boolean,
  scanned: boolean,
): readonly TestSuite[] {
  if (!scanned) return stack.suites
  return stack.suites.filter((suite) => {
    if (suite.id === 'ng-lint') return angularLint
    if (suite.id === 'ng-e2e') return angularE2e
    return true
  })
}

export function detectStacks(
  entries: readonly string[],
  read?: (entry: string) => string | null,
): AvailableSuites[] {
  const lower = entries.map((entry) => entry.toLowerCase().replace(/\\/g, '/'))
  const present = (pattern: string): boolean => {
    const needle = pattern.toLowerCase()
    return needle.startsWith('*.')
      ? lower.some((entry) => entry.endsWith(needle.slice(1)))
      : lower.some((entry) => entry === needle || entry.endsWith(`/${needle}`))
  }
  const api = read ? detectApi(entries, read) : false
  const angularLint = read ? angularHasLintTarget(entries, read) : false
  const angularE2e = read ? angularHasE2e(entries, read) : false
  return TEST_STACKS.filter((stack) => stack.detect.some(present)).map((stack) => ({
    stackId: stack.id,
    stackLabel: stack.id === 'dotnet' && api ? '.NET API' : stack.label,
    suites: suitesFor(stack, angularLint, angularE2e, read !== undefined),
  }))
}

export function stackEntries(root: string, list: (dir: string) => string[]): string[] {
  const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'out', 'release', '.vs'])
  const top = list(root)
  const nested: string[] = []
  for (const name of top) {
    if (SKIP.has(name.toLowerCase()) || name.startsWith('.')) continue
    try {
      for (const child of list(`${root}/${name}`)) nested.push(`${name}/${child}`)
    } catch {
    }
  }
  return [...top, ...nested]
}
