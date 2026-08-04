// The deterministic half of an API run: route discovery, host resolution, the
// verdict on a response, and reading request data back off a session's output.
//
// These are the pieces that replaced "ask the session whether the API works", so
// each one is checked directly: a wrong verdict here would be a green eval set
// that proves nothing, which is the exact failure the feature exists to remove.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apiVerdict,
  checkCall,
  recentEndpoints,
  scanEndpoints,
  searchEndpoints,
  type ApiCall,
  type ApiEvalRun,
  type ApiRequestPlan,
} from '@shared/api-endpoints'
import { API_DATA_MARKER, parseApiRequests } from '@main/evals/api-dispatch'
import { resolveApiHost, scanProjectEndpoints } from '@main/evals/api-scan'

const CONTROLLER = `
[ApiController]
[Route("api/[controller]")]
public sealed class CustomersController : ControllerBase
{
    [HttpGet]
    public Task<IActionResult> All() => throw null;

    [HttpGet("{id:int}")]
    public Task<IActionResult> One(int id) => throw null;

    [HttpPost("search")]
    public Task<IActionResult> Search() => throw null;

    [HttpGet("/health")]
    public IActionResult Health() => Ok();
}
`

describe('scanEndpoints', () => {
  it('joins a controller route prefix to each action, substituting [controller]', () => {
    const found = scanEndpoints([{ path: 'Api/CustomersController.cs', text: CONTROLLER }])
    expect(found.map((e) => `${e.method} ${e.template}`)).toEqual([
      'GET /api/Customers',
      'GET /api/Customers/{id:int}',
      'POST /api/Customers/search',
      // A leading slash on the action replaces the prefix, as routing does.
      'GET /health',
    ])
    expect(found[0].source).toBe('Api/CustomersController.cs:6')
  })

  it('substitutes the API version, so a versioned route is callable', () => {
    // The shape Asp.Versioning writes, and the shape every controller in the real
    // Pepkor External API uses. Left as a placeholder, every route it found was
    // uncallable and the version became something a model had to guess.
    const versioned = `
[ApiVersion("2")]
[Route("v{version:apiVersion}/[controller]")]
public class PosV2Controller : ApiControllerBase
{
    [HttpPost("payment")]
    public Task<IActionResult> Payment() => throw null;
}
`
    const found = scanEndpoints([{ path: 'Controllers/PosV2Controller.cs', text: versioned }])
    expect(found.map((e) => `${e.method} ${e.template}`)).toEqual(['POST /v2/PosV2/payment'])
  })

  it('leaves the version alone when the file never states one', () => {
    const noVersion = `
[Route("v{version:apiVersion}/[controller]")]
public class ThingController : ControllerBase
{
    [HttpGet]
    public Task<IActionResult> All() => throw null;
}
`
    const found = scanEndpoints([{ path: 'Controllers/ThingController.cs', text: noVersion }])
    expect(found[0].template).toBe('/v{version:apiVersion}/Thing')
  })

  it('finds minimal API and router registrations', () => {
    const found = scanEndpoints([
      {
        path: 'Program.cs',
        text: 'app.MapGet("/api/orders", Handler);\napp.MapPost<Create>("/api/orders", Create);',
      },
      { path: 'server.js', text: "router.delete('/api/orders/:id', remove)" },
    ])
    expect(found.map((e) => `${e.method} ${e.template}`)).toEqual([
      'GET /api/orders',
      'POST /api/orders',
      'DELETE /api/orders/:id',
    ])
  })

  it('reads a .http file and drops scheme, host and variable prefixes', () => {
    const found = scanEndpoints([
      {
        path: 'requests.http',
        text: '@base = x\nGET {{baseUrl}}/api/contracts/4417\n\n###\nPOST https://localhost:5057/api/contracts\n',
      },
    ])
    expect(found).toEqual([
      { method: 'GET', template: '/api/contracts/4417', source: 'requests.http:2' },
      { method: 'POST', template: '/api/contracts', source: 'requests.http:5' },
    ])
  })

  it('deduplicates a route declared in more than one place', () => {
    const found = scanEndpoints([
      { path: 'a.cs', text: 'app.MapGet("/api/x", A);' },
      { path: 'b.cs', text: 'app.MapGet("api/x", B);' },
    ])
    expect(found).toHaveLength(1)
    expect(found[0].source).toBe('a.cs:1')
  })
})

describe('searchEndpoints', () => {
  const all = [
    { method: 'GET', template: '/api/customers', source: 'A.cs:1' },
    { method: 'POST', template: '/api/orders', source: 'B.cs:2' },
  ]

  it('matches on path, method and file, and returns everything for an empty term', () => {
    expect(searchEndpoints(all, 'order')).toHaveLength(1)
    expect(searchEndpoints(all, 'post')).toHaveLength(1)
    expect(searchEndpoints(all, 'A.cs')).toHaveLength(1)
    expect(searchEndpoints(all, '  ')).toHaveLength(2)
  })
})

describe('checkCall', () => {
  const expectation = { status: null, minItems: null, mustContain: null }

  it('holds a call to the status it was told to expect', () => {
    expect(checkCall({ ...expectation, status: 404 }, 404, '')).toEqual({
      outcome: 'pass',
      detail: null,
    })
    expect(checkCall({ ...expectation, status: 404 }, 200, '{}')).toEqual({
      outcome: 'fail',
      detail: 'expected 404, got 200',
    })
  })

  it('treats an unstated status as "any 2xx"', () => {
    expect(checkCall(expectation, 204, '').outcome).toBe('pass')
    expect(checkCall(expectation, 500, 'boom')).toEqual({
      outcome: 'fail',
      detail: 'expected a 2xx, got 500',
    })
  })

  it('counts the items in an array body, including a single wrapped array', () => {
    expect(checkCall({ ...expectation, minItems: 3 }, 200, '[1,2,3]').outcome).toBe('pass')
    expect(checkCall({ ...expectation, minItems: 3 }, 200, '{"items":[1,2,3]}').outcome).toBe('pass')
    expect(checkCall({ ...expectation, minItems: 3 }, 200, '[1,2]')).toEqual({
      outcome: 'fail',
      detail: 'expected at least 3 items, got 2',
    })
  })

  it('fails a 200 with an empty body when items were expected — the trap this exists for', () => {
    expect(checkCall({ ...expectation, minItems: 1 }, 200, '')).toEqual({
      outcome: 'fail',
      detail: 'expected a JSON array of at least 1, but the body is not an array',
    })
  })

  it('requires text the data said would be there', () => {
    expect(checkCall({ ...expectation, mustContain: 'Acme' }, 200, '{"name":"Acme"}').outcome).toBe(
      'pass',
    )
    expect(checkCall({ ...expectation, mustContain: 'Acme' }, 200, '{"name":"Other"}')).toEqual({
      outcome: 'fail',
      detail: 'the response does not contain "Acme"',
    })
  })
})

describe('apiVerdict', () => {
  const call = (outcome: ApiCall['outcome']): ApiCall => ({
    request: {
      template: '/x',
      method: 'GET',
      path: '/x',
      body: null,
      headers: null,
      expect: { status: null, minItems: null, mustContain: null },
      note: null,
      dataSource: null,
      dataQuery: null,
    },
    status: 200,
    ms: 5,
    body: '{}',
    outcome,
    detail: null,
  })

  it('never reports a pass for a run that called nothing', () => {
    expect(apiVerdict([])).toBe('error')
    expect(apiVerdict([call('not_run')])).toBe('error')
  })

  it('fails on any failed call, and passes only when every call completed', () => {
    expect(apiVerdict([call('pass'), call('fail')])).toBe('fail')
    // A call that never went out takes PASS away: one endpoint answering while
    // four time out is a run that mostly did not happen, and the badge is what a
    // developer reads before anything else.
    expect(apiVerdict([call('pass'), call('not_run')])).toBe('error')
    expect(apiVerdict([call('pass')])).toBe('pass')
  })
})

describe('parseApiRequests', () => {
  it('reads the last marker line and coerces a stringy status', () => {
    const text = [
      `I will use ${API_DATA_MARKER}: as the sentinel.`,
      'Queried the database, customer 4417 has 3 contracts.',
      `${API_DATA_MARKER}: {"requests":[{"template":"/api/c/{id}","method":"get","path":"api/c/4417",` +
        '"expect":{"status":"200","minItems":"3","mustContain":null},"note":"3 contracts",' +
        '"dataSource":"oracle-sqlcl","dataQuery":"select 1 from dual"}]}',
    ].join('\n')
    const parsed = parseApiRequests(text) as ApiRequestPlan[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      method: 'GET',
      // A path without a leading slash still joins to the base URL correctly.
      path: '/api/c/4417',
      expect: { status: 200, minItems: 3, mustContain: null },
      dataSource: 'oracle-sqlcl',
    })
  })

  it('drops a request with no usable method or path rather than repairing it', () => {
    const text = `${API_DATA_MARKER}: {"requests":[{"method":"FETCH","path":"/x"},{"method":"GET"},{"method":"GET","path":"/ok"}]}`
    expect(parseApiRequests(text)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/ok' }),
    ])
  })

  it('returns null when the session never reported', () => {
    expect(parseApiRequests('Ran some queries, then stopped.')).toBeNull()
    expect(parseApiRequests(`${API_DATA_MARKER}: not json`)).toBeNull()
  })

  // Same defect the verify reader had: slicing to the LAST brace in the turn let
  // one brace in a closing sentence swallow the whole request set, and the run
  // then reported that nothing was called.
  it('is not derailed by a closing brace in the prose after the data line', () => {
    const text =
      `${API_DATA_MARKER}: {"requests":[{"method":"GET","path":"/api/orders"}]}\n` +
      'The id comes from the route template (see /api/orders/{id}).'
    expect(parseApiRequests(text)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/orders' }),
    ])
  })

  it('defaults a missing expectation to "any 2xx" rather than to something that always passes', () => {
    const parsed = parseApiRequests(
      `${API_DATA_MARKER}: {"requests":[{"method":"GET","path":"/x"}]}`,
    ) as ApiRequestPlan[]
    expect(parsed[0].expect).toEqual({ status: null, minItems: null, mustContain: null })
  })
})

describe('recentEndpoints', () => {
  const run = (paths: string[]): ApiEvalRun => ({
    id: paths.join(),
    projectId: 'p',
    baseUrl: 'http://localhost:1',
    target: 'local',
    launched: false,
    sessionId: null,
    status: 'pass',
    note: null,
    calls: paths.map((template) => ({
      request: {
        template,
        method: 'GET',
        path: template,
        body: null,
        headers: null,
        expect: { status: null, minItems: null, mustContain: null },
        note: null,
        dataSource: null,
        dataQuery: null,
      },
      status: 200,
      ms: 1,
      body: null,
      outcome: 'pass' as const,
      detail: null,
    })),
    startedAt: '2026-07-29T00:00:00.000Z',
    finishedAt: '2026-07-29T00:00:01.000Z',
  })

  it('lists the most recently tested endpoints first, without repeats', () => {
    const recent = recentEndpoints([run(['/b', '/a']), run(['/a', '/c'])], 5)
    expect(recent.map((e) => e.template)).toEqual(['/b', '/a', '/c'])
  })

  it('stops at the limit', () => {
    expect(recentEndpoints([run(['/1', '/2', '/3', '/4', '/5', '/6'])], 5)).toHaveLength(5)
  })
})

describe('resolveApiHost', () => {
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'swb-api-'))
    const api = join(root, 'src', 'Sample.Api')
    mkdirSync(join(api, 'Properties'), { recursive: true })
    writeFileSync(
      join(api, 'Properties', 'launchSettings.json'),
      JSON.stringify({
        profiles: {
          https: { applicationUrl: 'https://localhost:7001;http://localhost:5057' },
        },
      }),
    )
    writeFileSync(join(api, 'Program.cs'), 'app.MapGet("/api/ping", () => "pong");')
    return root
  }

  it('takes the http URL from launchSettings and derives the start command', async () => {
    const host = await resolveApiHost(project(), {})
    expect(host).toMatchObject({ baseUrl: 'http://localhost:5057' })
    // https first in the file, http chosen: a dev certificate the run does not
    // trust would fail as if the API were broken.
    expect('startCmd' in host && host.startCmd).toContain('dotnet run --project')
  })

  it('prefers an explicit base URL but keeps the derived start command', async () => {
    const host = await resolveApiHost(project(), { baseUrl: 'http://127.0.0.1:9100/' })
    expect(host).toMatchObject({ baseUrl: 'http://127.0.0.1:9100' })
    expect('startCmd' in host && host.startCmd).toContain('dotnet run --project')
  })

  it('asks for a base URL rather than guessing a port', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'swb-bare-'))
    await expect(resolveApiHost(bare, {})).resolves.toEqual({
      error: expect.stringContaining('No base URL'),
    })
  })
})

describe('scanProjectEndpoints', () => {
  it('finds routes on disk with paths relative to the project root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swb-scan-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(join(root, 'src', 'Program.cs'), 'app.MapGet("/api/ping", Ping);')
    writeFileSync(join(root, 'node_modules', 'junk', 'index.js'), "app.get('/skipped', x)")
    const scan = await scanProjectEndpoints(root)
    expect(scan.endpoints).toEqual([
      { method: 'GET', template: '/api/ping', source: 'src/Program.cs:1' },
    ])
    expect(scan.truncated).toBe(false)
  })
})
