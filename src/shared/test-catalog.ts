export type SuiteKind = 'api' | 'unit' | 'ui' | 'coverage' | 'quality' | 'mutation'

export type SuiteTool = 'dotnet' | 'node' | 'python' | 'browser'

export type AppShape = 'api' | 'blazor'

export interface TestSuite {
  id: string
  kind: SuiteKind
  label: string
  acceptance: string
  command: string
  needs: SuiteTool
  mcp?: string
  heavy?: boolean
  appliesTo?: readonly AppShape[]
}

export interface TestStack {
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
        appliesTo: ['api'],
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
        appliesTo: ['api'],
      },
      {
        id: 'blazor-ui',
        kind: 'ui',
        label: 'Screens in a real browser',
        acceptance: 'the affected screens work end to end in a real browser',
        command:
          'start the app, drive the screens this working tree touched in a real browser with Playwright, and report each interaction with what actually happened',
        needs: 'browser',
        appliesTo: ['blazor'],
      },
      {
        id: 'blazor-interactive',
        kind: 'ui',
        label: 'Components become interactive',
        acceptance: 'a prerendered component actually takes over and responds to input',
        command:
          'load each affected page, then interact with a component that needs interactivity (a click that changes state) and report whether it responded, plus any error from the SignalR circuit or the WebAssembly bundle',
        needs: 'browser',
        appliesTo: ['blazor'],
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
        label: 'Unit tests (Karma/Jest)',
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
        id: 'ng-e2e',
        kind: 'ui',
        label: 'UI end-to-end',
        acceptance: 'the affected screens work end to end in a real browser',
        command: 'npx playwright test',
        needs: 'browser',
      },
      {
        id: 'ng-build',
        kind: 'quality',
        label: 'Production build',
        acceptance: 'the production build succeeds with no new warnings',
        command: 'npx ng build --configuration production',
        needs: 'node',
      },
      {
        id: 'ng-mutation',
        kind: 'mutation',
        label: 'Mutation testing (Stryker)',
        acceptance: 'the specs fail when the code is broken on purpose',
        command: 'npx stryker run',
        needs: 'browser',
        heavy: true,
      },
    ],
  },
  {
    id: 'node',
    label: 'Node / Vue / Electron',
    detect: ['package.json'],
    suites: [
      {
        id: 'node-unit',
        kind: 'unit',
        label: 'Unit tests',
        acceptance: 'every unit test passes',
        command: 'npm test',
        needs: 'node',
      },
      {
        id: 'node-coverage',
        kind: 'coverage',
        label: 'Coverage',
        acceptance: 'the changed code is covered by tests',
        command: 'npx vitest run --coverage --coverage.reporter=cobertura',
        needs: 'node',
      },
      {
        id: 'node-e2e',
        kind: 'ui',
        label: 'UI end-to-end (Playwright)',
        acceptance: 'the affected screens work end to end',
        command: 'npx playwright test',
        needs: 'browser',
      },
      {
        id: 'node-ui-shot',
        kind: 'ui',
        label: 'Screenshot the affected screen',
        acceptance: 'the affected screen looks right',
        command:
          'launch the app (npm run dev), screenshot the affected screen with Playwright, and report what differs from the acceptance line',
        needs: 'browser',
      },
      {
        id: 'node-api',
        kind: 'api',
        label: 'HTTP smoke',
        acceptance: 'every route answers with the status and shape it should',
        command:
          'start the server, then send one request per route and report status, shape, and any 4xx/5xx',
        needs: 'node',
      },
      {
        id: 'node-types',
        kind: 'quality',
        label: 'Types and lint',
        acceptance: 'types and lint are clean',
        command: 'npm run typecheck && npm run lint',
        needs: 'node',
      },
      {
        id: 'node-mutation',
        kind: 'mutation',
        label: 'Mutation testing (Stryker)',
        acceptance: 'the tests fail when the code is broken on purpose',
        command: 'npx stryker run',
        needs: 'node',
        heavy: true,
      },
    ],
  },
  {
    id: 'python',
    label: 'Python',
    detect: ['pyproject.toml', 'requirements.txt'],
    suites: [
      {
        id: 'py-unit',
        kind: 'unit',
        label: 'Unit tests',
        acceptance: 'every test passes',
        command: 'python -m pytest -q',
        needs: 'python',
      },
      {
        id: 'py-coverage',
        kind: 'coverage',
        label: 'Coverage',
        acceptance: 'the changed code is covered',
        command: 'python -m pytest -q --cov --cov-report=xml:coverage.cobertura.xml',
        needs: 'python',
      },
      {
        id: 'py-api',
        kind: 'api',
        label: 'HTTP smoke',
        acceptance: 'every route answers with the status and shape it should',
        command: 'start the app, then send one request per route and report status, shape, and errors',
        needs: 'python',
      },
      {
        id: 'py-quality',
        kind: 'quality',
        label: 'Lint and types',
        acceptance: 'lint and types are clean',
        command: 'python -m ruff check . && python -m mypy .',
        needs: 'python',
      },
      {
        id: 'py-mutation',
        kind: 'mutation',
        label: 'Mutation testing (mutmut)',
        acceptance: 'the tests fail when the code is broken on purpose',
        command: 'python -m mutmut run',
        needs: 'python',
        heavy: true,
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

export function defaultSelection(suites: readonly TestSuite[], sandbox: SandboxEnv): string[] {
  return suites.filter((s) => !s.heavy && !unavailableReason(s, sandbox)).map((s) => s.id)
}

export interface VerifyGate {
  id: 'unit' | 'integration' | 'architecture' | 'mutation' | 'coverage' | 'quality-service'
  name: string
  panel: 'qa' | 'coverage' | 'quality' | 'evidence'
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

function detectAppShapes(
  entries: readonly string[],
  read: (entry: string) => string | null,
): AppShape[] {
  const MAX_READS = 12
  const lower = entries.map((entry) => entry.replace(/\\/g, '/').toLowerCase())
  let blazor = lower.some(
    (entry) => entry.endsWith('.razor') || entry.endsWith('wwwroot/index.html'),
  )
  let api = lower.some(
    (entry) => entry.endsWith('.http') || entry === 'controllers' || entry.includes('controllers/'),
  )

  const readable = entries.filter((entry) => {
    const name = entry.replace(/\\/g, '/').toLowerCase()
    return name.endsWith('.csproj') || name.endsWith('program.cs') || name.endsWith('startup.cs')
  })
  for (const entry of readable.slice(0, MAX_READS)) {
    if (blazor && api) break
    const text = read(entry)
    if (!text) continue
    if (
      /AddRazorComponents|MapRazorComponents|AddInteractive\w*Components|RootComponents\.Add|AddServerSideBlazor|Microsoft\.NET\.Sdk\.BlazorWebAssembly/.test(
        text,
      )
    ) {
      blazor = true
    }
    if (/MapControllers|AddControllers|MapOpenApi|AddOpenApi|AddSwaggerGen/.test(text)) api = true
  }

  const shapes: AppShape[] = []
  if (api) shapes.push('api')
  if (blazor) shapes.push('blazor')
  return shapes
}

function suitesFor(
  stack: TestStack,
  shapes: readonly AppShape[],
  scanned: boolean,
): readonly TestSuite[] {
  if (!scanned) return stack.suites
  return stack.suites.filter((suite) => {
    if (!suite.appliesTo) return true
    if (suite.appliesTo.some((shape) => shapes.includes(shape))) return true
    return shapes.length === 0 && !suite.appliesTo.every((shape) => shape === 'blazor')
  })
}

function hasCoverageProvider(
  entries: readonly string[],
  read: (entry: string) => string | null,
): boolean {
  for (const entry of entries.filter((e) => /(^|[\\/])package\.json$/i.test(e)).slice(0, 8)) {
    const text = read(entry)
    if (text && /"@vitest\/coverage-[a-z0-9]+"|"jest"|"nyc"|"c8"/.test(text)) return true
  }
  return false
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
  const shapes = read ? detectAppShapes(entries, read) : []
  const coverage = read ? hasCoverageProvider(entries, read) : true
  return TEST_STACKS.filter((stack) => stack.detect.some(present)).map((stack) => ({
    stackId: stack.id,
    stackLabel: stack.id === 'dotnet' ? dotnetLabel(shapes) : stack.label,
    suites: suitesFor(stack, shapes, read !== undefined).filter(
      (suite) => coverage || suite.id !== 'node-coverage',
    ),
  }))
}

function dotnetLabel(shapes: readonly AppShape[]): string {
  if (shapes.includes('api') && shapes.includes('blazor')) return '.NET API + Blazor'
  if (shapes.includes('blazor')) return '.NET Blazor'
  if (shapes.includes('api')) return '.NET API'
  return '.NET'
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
