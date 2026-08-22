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
// No 'contract': no suite in TEST_STACKS was ever given that kind, so the only
// code branching on it could never be taken. Add it back with the suite that
// needs it, not before.
export type SuiteKind = 'api' | 'unit' | 'ui' | 'coverage' | 'quality' | 'mutation'

/**
 * The toolchain a suite needs on PATH wherever the session runs. Named because a
 * bypass session runs inside the Linux sandbox container, which ships node — and
 * .NET only for a .NET project — see sandboxTools().
 */
export type SuiteTool = 'dotnet' | 'node' | 'python' | 'browser'

/**
 * The kind of application a project holds, which decides what verifying it even
 * means. One .NET solution can hold both.
 *
 * This exists because ".NET" is not a single thing to test. An HTTP smoke pass
 * over the endpoints is the strongest evidence there is for a Web API and close to
 * worthless for a Blazor front end: every interactive render mode prerenders
 * first, so the server's HTML says nothing about whether the component ever
 * became interactive — see the Blazor suites below.
 */
export type AppShape = 'api' | 'blazor'

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
  /**
   * Answered through an MCP server rather than by running a shell command, naming
   * the server to use. `command` then holds the instruction rather than a command
   * line, and the run says so instead of telling the session to execute it.
   *
   * Needed because the two most useful checks a .NET project has are not commands:
   * a quality gate lives in SonarQube and is read over its API, and Roslyn analysis
   * runs in a language server. Shelling out to a scanner would need a host URL and
   * a token, which this app deliberately does not ask anyone to paste into it; the
   * MCP server already holds that connection.
   */
  mcp?: string
  /** Minutes, not seconds: excluded from a default run, opt in per run (FR-058). */
  heavy?: boolean
  /**
   * Offer this suite only to a project of one of these shapes. Absent means it
   * applies whatever the project is, and a project whose shape could not be read
   * is offered everything rather than having suites hidden from it on a guess.
   */
  appliesTo?: readonly AppShape[]
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
    // Shape-agnostic: detectStacks narrows it to ".NET API", ".NET Blazor" or
    // both once it has read what the project actually is.
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
        // Deliberately prose, not a shell one-liner: this suite is the one that
        // draws identifiers from a connected database MCP server, calls the
        // endpoints with them, and checks the response back against those rows.
        // The full instruction lives in verify-dispatch's endpointSection.
        command:
          "start the API, take real identifiers from the project's database MCP server, call the endpoints with them (plus the project's .http file if present), and check each response back against the data",
        needs: 'dotnet',
        appliesTo: ['api'],
      },
      // --- Blazor. A front end is not verified by asking its host for HTML. ---
      {
        id: 'blazor-ui',
        kind: 'ui',
        label: 'Screens in a real browser',
        acceptance: 'the affected screens work end to end in a real browser',
        // Prose for the same reason dotnet-http is: the value is in driving the
        // screens the working tree touched, which no fixed command line knows.
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
        // Every interactive render mode prerenders first (Microsoft Learn, Blazor
        // render modes), so the server's first HTML is identical whether or not
        // the circuit or the WebAssembly bundle ever arrived. This is the check
        // that separates "the page rendered" from "the page works", and it is the
        // one an HTTP smoke pass can never make.
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
        // Read, never run. The scanner needs a host and a token; the MCP server
        // already holds both, and asking the developer to paste a token into this
        // app to duplicate that would be a worse answer to the same question.
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
        // Stryker is a dotnet TOOL, not part of the SDK, so `needs: 'dotnet'` is
        // only true because wslc-sandbox.ts's .NET image installs it. It did
        // not, once, and the suite then reported the developer's code as failing
        // when nothing had ever been installed — the exact confusion FR-057
        // exists to prevent. If that RUN line ever leaves the image, this entry
        // has to go with it or gain a way to say "the tool is missing".
        //
        // No host-side probe: every verification run is containerised
        // (backgroundSessionFor), so the image IS the environment this runs in.
        // Add one if a native run ever becomes possible again.
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

/**
 * A .NET repo gets a sandbox image with the .NET SDK in it; everything else gets
 * the small node-only one (wslc-sandbox.ts builds both from this same answer).
 * Baking .NET into every image would cost ~1 GB for projects that never call it.
 */
export function sandboxNeedsDotnet(stacks: readonly AvailableSuites[]): boolean {
  return stacks.some((s) => s.stackId === 'dotnet')
}

/**
 * What the bypass sandbox image actually ships: node:22-slim plus git and
 * ripgrep, and — for a .NET project — the .NET SDK on top (wslc-sandbox.ts).
 * Never Python, never a browser, so those suites cannot run in a bypass session.
 * Saying so BEFORE the run is the point: an environment limit must never be
 * reported as a failure of the developer's code (FR-057).
 */
export function sandboxTools(dotnet: boolean, browser = false): readonly SuiteTool[] {
  const tools: SuiteTool[] = ['node']
  if (dotnet) tools.push('dotnet')
  if (browser) tools.push('browser')
  return tools
}

/**
 * Whether this project has real browser test infrastructure, and therefore whether
 * a bypass container should carry a browser.
 *
 * The catalog OFFERS a browser suite to almost everything: the node stack always
 * lists an end-to-end run and a screenshot pass, so "some suite wants a browser" is
 * true nearly always and is useless as a gate. What decides it is whether the
 * project actually drives a browser today, which is a cheap file question:
 * a Playwright config, a Karma config, an Angular workspace (its test builder runs
 * ChromeHeadless), or Playwright declared as a dependency.
 *
 * Getting this wrong is not symmetrical. A false negative costs the developer a
 * "browser is not in the bypass container" line, stated before the run, which is
 * the behaviour that shipped for years. A false positive costs every session on
 * that project a few hundred megabytes of image it never uses, so the gate is
 * deliberately evidence-led rather than generous.
 */
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
  // A project can drive Playwright with no config file of its own, so the manifest
  // is the second witness.
  for (const entry of entries.filter((e) => /(^|[\\/])package\.json$/i.test(e)).slice(0, 8)) {
    const text = read(entry)
    if (text && /"@playwright\/test"|"playwright"|"karma"|"cypress"/.test(text)) return true
  }
  return false
}

/** The sandbox a run happens in, or null when it runs natively on the host. */
export type SandboxEnv = readonly SuiteTool[] | null

/** Why a suite is unavailable here, in the developer's words — or null if it can run. */
export function unavailableReason(suite: TestSuite, sandbox: SandboxEnv): string | null {
  if (!sandbox || sandbox.includes(suite.needs)) return null
  return `${suite.needs} is not in the bypass container`
}

/** The suites a plain "run verification" covers: everything runnable, minus the
 *  heavy ones, which are opt-in per run (FR-058). */
export function defaultSelection(suites: readonly TestSuite[], sandbox: SandboxEnv): string[] {
  return suites.filter((s) => !s.heavy && !unavailableReason(s, sandbox)).map((s) => s.id)
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
 * What kind of .NET application this project holds, from the framework calls
 * themselves rather than from names.
 *
 * The fingerprints are the registration calls, because those are what the
 * framework requires and therefore cannot be absent from a working app:
 * `AddRazorComponents`/`MapRazorComponents` and the per-render-mode
 * `AddInteractive*Components` for a Blazor Web App, `RootComponents.Add` or
 * `AddServerSideBlazor` for the standalone and legacy hosting models, against
 * `MapControllers`/`AddControllers` or an OpenAPI registration for a Web API.
 * A class called `SomethingController` is NOT evidence — plenty of code is named
 * that way without ever being routed.
 *
 * `read` returns a file's text or null, and is given entry paths exactly as
 * `stackEntries` produced them. Only project and startup files are opened, and at
 * most `MAX_READS` of them, so detection stays a handful of small reads.
 */
function detectAppShapes(
  entries: readonly string[],
  read: (entry: string) => string | null,
): AppShape[] {
  const MAX_READS = 12
  const lower = entries.map((entry) => entry.replace(/\\/g, '/').toLowerCase())
  let blazor = lower.some(
    (entry) => entry.endsWith('.razor') || entry.endsWith('wwwroot/index.html'),
  )
  // A `Controllers` folder is a convention rather than proof, and it is admitted
  // on purpose: the two mistakes are not symmetrical. Calling an API an API when
  // it is not restores exactly today's behaviour, whereas calling a service a
  // Blazor app sends a browser suite at a project that has no screens. So the
  // API side takes the conventional signal and the Blazor side does not.
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

/**
 * The suites a stack offers a project of these shapes.
 *
 * `scanned` says whether the tree was actually read. Without a read there is no
 * evidence either way and every suite is offered, which is what the sandbox-image
 * decision wants — it only asks whether .NET is needed at all.
 *
 * With a read, an EMPTY shape list is not "we do not know". It withholds
 * screen-driving suites, and the asymmetry is deliberate — the same asymmetry
 * detectAppShapes already argues for on its API side. Blazor is detected from
 * file evidence: a `.razor` component, a `wwwroot/index.html`, or a Razor
 * registration in Program.cs. A .NET project with none of those has no screens,
 * so "drive the affected screens in a real browser" is an offer to test something
 * that does not exist, and it was being offered to plain Web APIs.
 *
 * The two mistakes are not equal. Offering an API suite to something that turns
 * out not to be an API costs one skipped suite. Offering a browser suite to a
 * headless service costs a run that goes looking for a UI, finds none, and
 * reports that as a failure of the code.
 */
function suitesFor(
  stack: TestStack,
  shapes: readonly AppShape[],
  scanned: boolean,
): readonly TestSuite[] {
  if (!scanned) return stack.suites
  return stack.suites.filter((suite) => {
    if (!suite.appliesTo) return true
    if (suite.appliesTo.some((shape) => shapes.includes(shape))) return true
    // Nothing confirmed: keep the API-side suites, withhold the screen-driving
    // ones. A suite that applies to both is kept by the line above.
    return shapes.length === 0 && !suite.appliesTo.every((shape) => shape === 'blazor')
  })
}

/**
 * Whether a Node project can actually collect coverage.
 *
 * Vitest does not ship a coverage provider: `vitest run --coverage` without
 * `@vitest/coverage-v8` or `@vitest/coverage-istanbul` installed fails outright.
 * That matters more than a missing figure, because a verification run stops at its
 * first failing suite — so a suite the project was never equipped for aborted the
 * whole ordered run, and everything after it reported as "not run". An environment
 * limit swallowing the developer's actual results is the failure mode this product
 * exists to prevent, so the suite is not offered where it cannot work. The coverage
 * gate then reads "—" with no source, which is the honest state: nothing measured
 * it. Installing a provider brings the suite back with no further change.
 *
 * Jest, nyc and c8 count too: each collects coverage on its own.
 */
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

/**
 * The stacks whose marker files are present, in catalog order. A project holding
 * several stacks reports all of them (FR-033), so an API and its front end both
 * get their suites.
 *
 * `read` is optional. With it, a .NET stack is narrowed to what the project
 * actually is, so a Blazor front end is not offered an HTTP smoke pass over
 * endpoints it does not have, and an API is not asked to drive screens. Without
 * it, every suite is offered — which is what the sandbox image decision wants,
 * since that only asks whether .NET is needed at all.
 */
export function detectStacks(
  entries: readonly string[],
  read?: (entry: string) => string | null,
): AvailableSuites[] {
  // Entries may be plain names or one-level paths ("Api/Api.sln"), so an exact
  // marker is matched against the basename rather than the whole string.
  const lower = entries.map((entry) => entry.toLowerCase().replace(/\\/g, '/'))
  const present = (pattern: string): boolean => {
    const needle = pattern.toLowerCase()
    return needle.startsWith('*.')
      ? lower.some((entry) => entry.endsWith(needle.slice(1)))
      : lower.some((entry) => entry === needle || entry.endsWith(`/${needle}`))
  }
  const shapes = read ? detectAppShapes(entries, read) : []
  // Only asked when the files can be read at all: without `read` every suite is
  // offered, which is what the sandbox-image decision wants.
  const coverage = read ? hasCoverageProvider(entries, read) : true
  return TEST_STACKS.filter((stack) => stack.detect.some(present)).map((stack) => ({
    stackId: stack.id,
    stackLabel: stack.id === 'dotnet' ? dotnetLabel(shapes) : stack.label,
    suites: suitesFor(stack, shapes, read !== undefined).filter(
      (suite) => coverage || suite.id !== 'node-coverage',
    ),
  }))
}

/** ".NET" narrowed to what was actually found, so the header names the thing being
 *  verified instead of listing everything .NET could be. */
function dotnetLabel(shapes: readonly AppShape[]): string {
  if (shapes.includes('api') && shapes.includes('blazor')) return '.NET API + Blazor'
  if (shapes.includes('blazor')) return '.NET Blazor'
  if (shapes.includes('api')) return '.NET API'
  return '.NET'
}

/**
 * Entry names to hand detectStacks: the project root plus one level down.
 *
 * A solution very often does not sit in the folder the developer registered.
 * `ExternalAPI/Ppl.Einstein.External.Api/*.sln` and
 * `MessageOrchestrator/Pepkor.MessageOrchestrator/*.slnx` are both real cases
 * that a root-only scan reported as having no stack at all, which emptied the
 * Tests section and sent the bypass session to the node-only sandbox image.
 *
 * One level, not a recursive walk: it covers the common "repo wraps the solution"
 * shape without walking node_modules, bin, or obj on every detection.
 *
 * `list` is injected so this stays free of node:fs and usable from either process.
 */
export function stackEntries(root: string, list: (dir: string) => string[]): string[] {
  const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'out', 'release', '.vs'])
  const top = list(root)
  const nested: string[] = []
  for (const name of top) {
    if (SKIP.has(name.toLowerCase()) || name.startsWith('.')) continue
    // Do NOT guess directory-ness from the name. An earlier cut skipped anything
    // with a trailing extension, which silently excluded `Ppl.Einstein.External.Api`
    // and every other dotted .NET folder name — the exact ecosystem this exists
    // for. Attempting the listing and letting a file throw is the only reliable
    // test, and a project root holds few enough entries for that to be free.
    try {
      for (const child of list(`${root}/${name}`)) nested.push(`${name}/${child}`)
    } catch {
      // Not a directory, or unreadable. Detection is a hint, never a blocker.
    }
  }
  return [...top, ...nested]
}
