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
export type SuiteKind = 'api' | 'unit' | 'ui' | 'coverage' | 'contract' | 'quality'

export interface TestSuite {
  /** Stable id, unique within a stack. */
  id: string
  kind: SuiteKind
  label: string
  /** What it proves, in the developer's words — becomes the acceptance line. */
  acceptance: string
  /** The command that proves it. Run in the project root through the session. */
  command: string
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
      },
      {
        id: 'dotnet-coverage',
        kind: 'coverage',
        label: 'Coverage',
        acceptance: 'the changed code is covered by tests',
        command: 'dotnet test --nologo --collect:"XPlat Code Coverage"',
      },
      {
        id: 'dotnet-api',
        kind: 'api',
        label: 'API integration tests',
        acceptance: 'every endpoint answers as its contract says (status, shape, auth)',
        command: 'dotnet test --nologo --filter Category=Integration',
      },
      {
        id: 'dotnet-http',
        kind: 'api',
        label: 'HTTP smoke (.http file)',
        acceptance: 'the running API answers the requests in the .http file as expected',
        command: 'dotnet run & then send each request in the project\'s .http file and report status + body',
      },
      {
        id: 'dotnet-arch',
        kind: 'quality',
        label: 'Architecture rules',
        acceptance: 'no layer depends on something it may not depend on',
        command: 'dotnet test --nologo --filter Category=Architecture',
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
      },
      {
        id: 'ng-coverage',
        kind: 'coverage',
        label: 'Coverage',
        acceptance: 'the changed components are covered',
        command: 'npx ng test --watch=false --code-coverage --browsers=ChromeHeadless',
      },
      {
        id: 'ng-e2e',
        kind: 'ui',
        label: 'UI end-to-end',
        acceptance: 'the affected screens work end to end in a real browser',
        command: 'npx playwright test',
      },
      {
        id: 'ng-build',
        kind: 'quality',
        label: 'Production build',
        acceptance: 'the production build succeeds with no new warnings',
        command: 'npx ng build --configuration production',
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
      },
      {
        id: 'node-e2e',
        kind: 'ui',
        label: 'UI end-to-end (Playwright)',
        acceptance: 'the affected screens work end to end',
        command: 'npx playwright test',
      },
      {
        id: 'node-ui-shot',
        kind: 'ui',
        label: 'Screenshot the affected screen',
        acceptance: 'the affected screen looks right',
        command:
          'launch the app (npm run dev), screenshot the affected screen with Playwright, and report what differs from the acceptance line',
      },
      {
        id: 'node-api',
        kind: 'api',
        label: 'HTTP smoke',
        acceptance: 'every route answers with the status and shape it should',
        command:
          'start the server, then send one request per route and report status, shape, and any 4xx/5xx',
      },
      {
        id: 'node-types',
        kind: 'quality',
        label: 'Types and lint',
        acceptance: 'types and lint are clean',
        command: 'npm run typecheck && npm run lint',
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
      },
      {
        id: 'py-coverage',
        kind: 'coverage',
        label: 'Coverage',
        acceptance: 'the changed code is covered',
        command: 'python -m pytest -q --cov',
      },
      {
        id: 'py-api',
        kind: 'api',
        label: 'HTTP smoke',
        acceptance: 'every route answers with the status and shape it should',
        command: 'start the app, then send one request per route and report status, shape, and errors',
      },
    ],
  },
]

/**
 * The six verification gates the Tests section reports, in the design's order.
 *
 * `built` is the honest bit: a gate is built when the app can actually produce
 * its verdict today, which for now means "run one command through the session
 * and read the PASS/FAIL it reports". Coverage, mutation and the code-quality
 * service need a report parsed out of a tool the app does not read yet, so their
 * tiles and panels say so rather than showing a number nothing measured
 * (FR-072: never derive, estimate or substitute a figure we did not measure).
 */
export interface VerifyGate {
  id: 'unit' | 'integration' | 'architecture' | 'mutation' | 'coverage' | 'quality-service'
  /** Tile label, in the design's caps. */
  name: string
  /** Which suite kind produces it, or null when nothing does yet. */
  from: SuiteKind | null
  /** The sub-tab the tile jumps to. */
  panel: 'qa' | 'coverage' | 'quality' | 'evidence'
  built: boolean
  /** Threshold shown on the gate bar. */
  target: string
}

export const VERIFY_GATES: readonly VerifyGate[] = [
  { id: 'unit', name: 'UNIT', from: 'unit', panel: 'qa', built: true, target: 'all pass' },
  { id: 'integration', name: 'INTEGRATION', from: 'api', panel: 'qa', built: true, target: 'all pass' },
  { id: 'architecture', name: 'ARCHITECTURE', from: 'quality', panel: 'quality', built: true, target: '0 violations' },
  { id: 'mutation', name: 'MUTATION', from: null, panel: 'quality', built: false, target: '≥ 70%' },
  { id: 'coverage', name: 'COVERAGE', from: 'coverage', panel: 'coverage', built: false, target: '≥ 80% line · ≥ 90% changed' },
  { id: 'quality-service', name: 'CODE QUALITY', from: null, panel: 'quality', built: false, target: 'gate passes · ≤ 3% duplication' },
]

/** A stack by id, for the chosen-profile header. */
export function stackById(id: string | undefined): TestStack | null {
  return TEST_STACKS.find((s) => s.id === id) ?? null
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
