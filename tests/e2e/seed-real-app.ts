// Seeds a throwaway userData directory for the real-Electron test, using the
// app's OWN schema, migrations and repositories rather than hand-written SQL —
// a seed that drifts from the real schema would prove nothing about the real app.
//
// Runs in the Playwright Node context (not the renderer), before the app launches.
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/store/db'
import { createRepositories } from '../../src/main/store/repositories'
import { parseVerifyReport, VERIFY_MARKER } from '../../src/main/evals/verify-dispatch'
import { verifyVerdict, DEFAULT_SETTINGS } from '../../src/shared/domain'

export interface SeededApp {
  /** Passed to Electron as --user-data-dir, so the real database is never touched. */
  userDataDir: string
  projectId: string
  projectPath: string
}

/**
 * A project that detects as .NET, with an active session row already present.
 *
 * The session row matters: `verify.start` reuses an active session instead of
 * spawning one, so the test drives the real failing call without starting a real
 * Claude session or spending tokens.
 */
export function seedRealApp(): SeededApp {
  const userDataDir = mkdtempSync(join(tmpdir(), 'switchboard-realapp-'))
  const projectPath = mkdtempSync(join(tmpdir(), 'switchboard-dotnet-'))

  // A solution file marks the stack; the Controllers folder and the routed
  // MapControllers call mark it as an API rather than a Blazor front end, so the
  // Tests section offers the endpoint suites and none of the browser ones.
  mkdirSync(join(projectPath, 'Controllers'), { recursive: true })
  writeFileSync(join(projectPath, 'Sample.Api.sln'), '\n')
  writeFileSync(
    join(projectPath, 'Sample.Api.csproj'),
    '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
  )
  writeFileSync(
    join(projectPath, 'Program.cs'),
    'var builder = WebApplication.CreateBuilder(args);\n' +
      'builder.Services.AddControllers();\n' +
      'var app = builder.Build();\n' +
      'app.MapControllers();\n' +
      'app.Run();\n',
  )
  writeFileSync(join(projectPath, 'Controllers', 'PoliciesController.cs'), '// placeholder\n')
  execSync('git init', { cwd: projectPath, stdio: 'ignore' })

  const db = openDatabase(join(userDataDir, 'switchboard.db'))
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'sample-api', path: projectPath, source: 'manual' })

  repos.sessions.insert({
    id: 'seeded-session',
    projectId: project.id,
    sdkSessionId: null,
    // 'done' is the schema's idle-but-alive state; the row has endedAt null, so
    // activeForProject finds it and verify.start reuses it instead of spawning.
    status: 'done',
    statusDetail: null,
    branch: 'main',
    diffAdds: 0,
    diffDels: 0,
    usageUtilization: null,
    usageResetsAt: null,
    usageLimitType: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    bypassPermissions: false,
  })

  // Land straight on the .NET stack: the picker is not what is under test.
  repos.settings.set({ ...DEFAULT_SETTINGS, projectTestStacks: { [project.id]: 'dotnet' } })

  seedFinishedRun(repos, project.id)
  db.close()

  return { userDataDir, projectId: project.id, projectPath }
}

/**
 * A finished run whose report is produced by the REAL parser from a marker line,
 * exactly as a session's output is.
 *
 * Hand-building a VerifyReport object would skip the parser and prove only that
 * the template renders a literal. Going through parseVerifyReport means the whole
 * path is exercised: marker line, parser, database, IPC, real renderer. The figures
 * are illustrative rather than measured, which is why this only ever runs against
 * a throwaway userData directory.
 */
function seedFinishedRun(repos: ReturnType<typeof createRepositories>, projectId: string): void {
  const line = `${VERIFY_MARKER}: ${JSON.stringify({
    suites: [
      { id: 'dotnet-unit', status: 'pass', detail: '318 passed' },
      { id: 'dotnet-api', status: 'pass', detail: '24 integration tests' },
      { id: 'dotnet-http', status: 'fail', detail: 'one endpoint answered 500' },
    ],
    coverage: {
      line: { value: 78.2, source: 'dotnet test --collect:"XPlat Code Coverage"' },
      changed: { value: 91, source: 'coverage vs git diff' },
      files: [],
    },
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/policies/PL-88213',
        status: 200,
        ms: 96,
        response: '{"id":"PL-88213","holderRef":"H-5512","contracts":3,"status":"Active"}',
        dataSource: 'postgres-reporting (read only)',
        dataQuery: "select id from policies where status = 'Active' limit 1",
        dataAssertion: 'the row lists 3 contracts; the response listed 3',
        outcome: 'pass',
        detail: 'answered with the policy the query named',
      },
      {
        method: 'GET',
        path: '/api/v1/policies/PL-00000/contracts',
        status: 200,
        ms: 41,
        response: '[]',
        dataSource: 'postgres-reporting (read only)',
        dataQuery: 'select 1 from policies where id = \'PL-00000\'',
        dataAssertion: 'no such policy, so an empty 200 is wrong; this must be a 404',
        outcome: 'fail',
        detail: 'returns 200 with an empty list for an id that does not exist',
      },
      {
        method: 'POST',
        path: '/api/v1/quotes',
        status: null,
        ms: null,
        response: null,
        dataSource: null,
        dataQuery: null,
        dataAssertion: null,
        outcome: 'not_run',
        detail: 'write endpoint, and the project does not point at a test database',
      },
    ],
  })}`

  const report = parseVerifyReport(line)
  if (!report) throw new Error('seed report did not parse — the marker contract has changed')

  const run = repos.verifyRuns.start({
    projectId,
    stackId: 'dotnet',
    sessionId: 'seeded-session',
    branch: 'main',
    requested: ['dotnet-unit', 'dotnet-api', 'dotnet-http'],
  })
  repos.verifyRuns.finish(run.id, verifyVerdict(report), report, null)
}
