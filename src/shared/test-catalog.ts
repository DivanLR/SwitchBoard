// What "test this" means per stack (spec 002 FR-033/FR-035/FR-037, T002).
//
// The point is to write NO test runners: every suite here is a command the
// project's own tooling already provides, dispatched through the session like
// any other work (FR-041). The app's whole contribution is knowing which
// commands exist for a stack and which of them a given project can actually run
// — so covering APIs, front ends, and UIs costs a table entry, not a feature.
//
// ponytail: detection is "does this file exist", not a project-file parse. It is
// wrong only for unusual layouts, where the developer edits the command on the
// line anyway. Parse package.json/csproj only if that stops being true.

/** The kind of thing a suite proves, so the UI can group API vs FE vs UI work. */
export type SuiteKind = 'api' | 'unit' | 'ui' | 'coverage' | 'contract' | 'quality' | 'mutation'

/**
 * The toolchain a suite needs on PATH wherever the session runs. Named because a
 * bypass session runs inside the Linux sandbox container, which ships node and
 * nothing else — see SANDBOX_TOOLS.
 */
export type SuiteTool = 'dotnet' | 'node' | 'python' | 'browser'

export interface TestSuite {
  /** Stable id, unique within a stack. */
  id: string
  kind: SuiteKind
  label: string
  /** What it proves, in the developer's words — becomes the acceptance line. */
  acceptance: string
  /** The command that proves it. Run in the project root through the session. */
  command: string
  /** What has to exist for the command to run at all. */
  needs: SuiteTool
  /** Minutes, not seconds: excluded from a default run, opt in per run (FR-058). */
  heavy?: boolean
}

export interface TestStack {
  id: string
  label: string
  /** Any one of these existing in the project root marks the stack present. */
  detect: readonly string[]
  suites: readonly TestSuite[]
}

export const TEST_STACKS: readonly TestStack[] = [
  {
    id: 'dotnet',
    label: '.NET (API, Blazor, WinUI)',
    detect: ['*.sln', '*.slnx', 'Directory.Build.props', 'global.json'],
    suites: [
      {
        id: 'dotnet-unit',
        kind: 'unit',
        label: 'Unit tests',
        acceptance: 'the solution builds and every unit test passes',
        command: 'dotnet test --nologo',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-coverage',
        kind: 'coverage',
        label: 'Coverage',
        acceptance: 'the changed code is covered by tests',
        command: 'dotnet test --nologo --collect:"XPlat Code Coverage"',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-api',
        kind: 'api',
        label: 'API integration tests',
        acceptance: 'every endpoint answers as its contract says (status, shape, auth)',
        command: 'dotnet test --nologo --filter Category=Integration',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-http',
        kind: 'api',
        label: 'HTTP smoke (.http file)',
        acceptance: 'the running API answers the requests in the .http file as expected',
        command: 'dotnet run & then send each request in the project\'s .http file and report status + body',
        needs: 'dotnet',
      },
      {
        id: 'dotnet-arch',
        kind: 'quality',
        label: 'Architecture rules',
        acceptance: 'no layer depends on something it may not depend on',
        command: 'dotnet test --nologo --filter Category=Architecture',
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
        command: 'npx vitest run --coverage',
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
        command: 'python -m pytest -q --cov',
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

/**
 * What the bypass sandbox image actually ships: node:22-slim plus git and
 * ripgrep (docker-sandbox.ts). No .NET SDK, no Python, no browser — so those
 * suites cannot run in a bypass session, and saying so BEFORE the run is the
 * point: an environment limit must never be reported as a failure of the
 * developer's code (FR-057).
 */
export const SANDBOX_TOOLS: readonly SuiteTool[] = ['node']

export function runnableInSandbox(suite: TestSuite): boolean {
  return SANDBOX_TOOLS.includes(suite.needs)
}

/** Why a suite is unavailable here, in the developer's words — or null if it can run. */
export function unavailableReason(suite: TestSuite, sandboxed: boolean): string | null {
  if (!sandboxed || runnableInSandbox(suite)) return null
  return `${suite.needs} is not in the bypass container`
}

/** The suites a plain "run verification" covers: everything runnable, minus the
 *  heavy ones, which are opt-in per run (FR-058). */
export function defaultSelection(suites: readonly TestSuite[], sandboxed: boolean): string[] {
  return suites.filter((s) => !s.heavy && !unavailableReason(s, sandboxed)).map((s) => s.id)
}

/**
 * The six verification gates the Tests section reports, in the design's order.
 *
 * Every gate is produced by a verification run: the session runs the suites and
 * reports one machine-readable report line, and the tile shows what that report
 * measured. A figure the run did not measure stays "—" with the reason — the app
 * never derives, estimates or substitutes one (FR-072).
 */
export interface VerifyGate {
  id: 'unit' | 'integration' | 'architecture' | 'mutation' | 'coverage' | 'quality-service'
  /** Tile label, in the design's caps. */
  name: string
  /** The sub-tab the tile jumps to. */
  panel: 'qa' | 'coverage' | 'quality' | 'evidence'
  /** Threshold shown on the gate bar. */
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

/** A stack by id, for the chosen-profile header. */
export function stackById(id: string | undefined): TestStack | null {
  return TEST_STACKS.find((s) => s.id === id) ?? null
}

/** A suite by id across every stack — the report names suites by id alone. */
export function suiteById(id: string): TestSuite | null {
  for (const stack of TEST_STACKS) {
    const found = stack.suites.find((s) => s.id === id)
    if (found) return found
  }
  return null
}

/** Suites available for the stacks detected in a project, grouped per stack. */
export interface AvailableSuites {
  stackId: string
  stackLabel: string
  suites: readonly TestSuite[]
}

/**
 * The stacks whose marker files are present, in catalog order. A project holding
 * several stacks reports all of them (FR-033), so an API and its front end both
 * get their suites.
 */
export function detectStacks(rootEntries: readonly string[]): AvailableSuites[] {
  const lower = rootEntries.map((entry) => entry.toLowerCase())
  const present = (pattern: string): boolean => {
    const needle = pattern.toLowerCase()
    return needle.startsWith('*.')
      ? lower.some((entry) => entry.endsWith(needle.slice(1)))
      : lower.includes(needle)
  }
  return TEST_STACKS.filter((stack) => stack.detect.some(present)).map((stack) => ({
    stackId: stack.id,
    stackLabel: stack.label,
    suites: stack.suites,
  }))
}
