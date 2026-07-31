// The API eval set: which endpoints a project has, what one request against an
// endpoint looks like, and whether the response it actually returned passes.
//
// Everything in this file is deterministic and decided by the app, never by a
// model. The routes come from a scan of the project's own source; the verdict on
// a call is computed from the status and body that actually came back. A model is
// asked for exactly one thing — the DATA to send (identifiers that really exist,
// which only a database knows) — and its answer is a request plan the app then
// executes and judges itself. See api-dispatch.ts for that narrow question.

/** A route found in the project's own source, with where it was found. */
export interface DiscoveredEndpoint {
  /** Upper-case HTTP method. */
  method: string
  /** The route template as written, e.g. /api/customers/{id}. */
  template: string
  /** file:line, relative to the project root, so the developer can go there. */
  source: string
}

/**
 * What the app checks a response against. Deliberately small: every field is
 * something code can decide without judgement, so a call's verdict never depends
 * on a model's opinion of the body.
 */
export interface ApiExpect {
  /** Status the call should return. Null means any 2xx. */
  status: number | null
  /** The body must parse as a JSON array holding at least this many items. */
  minItems: number | null
  /** The body must contain this text verbatim. */
  mustContain: string | null
}

/** One request to send: fully concrete, with the real values already in it. */
export interface ApiRequestPlan {
  /** The discovered template this request exercises, so results group by route. */
  template: string
  method: string
  /** The concrete path, real values substituted, query string included. */
  path: string
  body: string | null
  headers: Record<string, string> | null
  expect: ApiExpect
  /** What the real data proves, e.g. "customer 4417 has 3 contracts". */
  note: string | null
  /** The MCP server the identifiers came from, e.g. "oracle-sqlcl". */
  dataSource: string | null
  /** The query run to obtain them, verbatim. */
  dataQuery: string | null
}

/** One call the app made, and how it judged the answer. */
export interface ApiCall {
  request: ApiRequestPlan
  /** Status actually received. Null means the call never completed. */
  status: number | null
  /** Round-trip milliseconds, null when the call never completed. */
  ms: number | null
  /** Response body, truncated. */
  body: string | null
  outcome: 'pass' | 'fail' | 'not_run'
  /** Why it failed, or why it never ran. */
  detail: string | null
}

export type ApiRunStatus = 'running' | 'pass' | 'fail' | 'error'

/**
 * Which environment a run went against.
 *
 * 'local' is the developer's own API, which the app may start and stop. 'qa' is a
 * deployed environment that already exists: it is never launched, never stopped,
 * and exercised as reads unless the developer says otherwise. The distinction is
 * recorded on the run because a report that does not name its environment is
 * evidence about nothing in particular.
 */
export type ApiTarget = 'local' | 'qa'

/** One eval set: the requests sent against one base URL, and their verdicts. */
export interface ApiEvalRun {
  id: string
  projectId: string
  /** Where the calls went. */
  baseUrl: string
  target: ApiTarget
  /** True when the app started the server for this run and stopped it after. */
  launched: boolean
  /** The session used ONLY to produce request data, kept so it is traceable. */
  sessionId: string | null
  status: ApiRunStatus
  /** Why a run that proved nothing proved nothing, in one line. */
  note: string | null
  calls: ApiCall[]
  startedAt: string
  finishedAt: string | null
}

const PATTERNS: readonly { re: RegExp; method?: string }[] = [
  // Minimal API and endpoint extensions: app.MapGet("/x", ...), MapPost<T>("/x").
  { re: /\bMap(Get|Post|Put|Patch|Delete)\s*(?:<[^()>]*>)?\s*\(\s*"([^"]*)"/g },
  // Express / Nest-style routers: app.get('/x'), router.post("/x").
  { re: /\b(?:app|router|server)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g },
]

/** Attribute routing: [HttpGet], [HttpGet("{id}")], [HttpPost("search")]. */
const ATTR_RE = /\[Http(Get|Post|Put|Patch|Delete)(?:\s*\(\s*"([^"]*)"\s*\))?/g

/**
 * Every route in the given files, deduplicated, in the order found.
 *
 * ponytail: regexes over source text, not a Roslyn parse and not a running
 * swagger document. It is wrong in the directions a scan is always wrong —
 * a route built by string concatenation, a MapGroup prefix — and the developer
 * can search the list and edit the path on the line anyway. Parse properly only
 * when a real project shows the scan missing routes that matter.
 */
export function scanEndpoints(
  files: readonly { path: string; text: string }[],
): DiscoveredEndpoint[] {
  const found = new Map<string, DiscoveredEndpoint>()
  const add = (method: string, template: string, path: string, index: number, text: string): void => {
    const normalised = normalisePath(template)
    if (!normalised) return
    const key = `${method} ${normalised}`
    if (found.has(key)) return
    found.set(key, { method, template: normalised, source: `${path}:${lineAt(text, index)}` })
  }

  for (const file of files) {
    if (file.path.toLowerCase().endsWith('.http')) {
      scanHttpFile(file, add)
      continue
    }
    for (const { re } of PATTERNS) {
      re.lastIndex = 0
      for (let m = re.exec(file.text); m; m = re.exec(file.text)) {
        add(m[1].toUpperCase(), m[2], file.path, m.index, file.text)
      }
    }
    if (file.path.toLowerCase().endsWith('.cs')) scanAttributes(file, add)
  }
  return [...found.values()]
}

type AddRoute = (
  method: string,
  template: string,
  path: string,
  index: number,
  text: string,
) => void

/**
 * A controller's routes: the class-level [Route(...)] prefix joined to each
 * action's [Http*] attribute, with [controller] and the API version substituted.
 *
 * The version matters as much as the controller name. A versioned API writes
 * `[Route("v{version:apiVersion}/[controller]")]`, and without substitution every
 * route is discovered as `/v{version:apiVersion}/account/get-notes` — a template
 * nothing can call. The value is in the same file, in `[ApiVersion("1")]`, so
 * leaving it as a placeholder meant handing a model a guess to make about a fact
 * the source already states. `Asp.Versioning` writes the segment exactly this way,
 * which is the shape this matches.
 *
 * ponytail: the first Route attribute, the first *Controller class and the first
 * ApiVersion in the file are taken as the set. One controller per file is the
 * convention everywhere, and a controller serving two versions gets the lower one
 * — still callable, where the placeholder was not.
 */
function scanAttributes(file: { path: string; text: string }, add: AddRoute): void {
  const controller = /\bclass\s+(\w+?)Controller\b/.exec(file.text)?.[1] ?? null
  const routeAttr = /\[Route\s*\(\s*"([^"]*)"\s*\)\s*\]/.exec(file.text)?.[1] ?? ''
  const version = /\[ApiVersion\s*\(\s*"([^"]+)"/.exec(file.text)?.[1] ?? null
  const named = controller ? routeAttr.replace(/\[controller\]/gi, controller) : routeAttr
  // No attribute means nothing to substitute: the template stays as written rather
  // than having a version invented for it.
  const prefix = version ? named.replace(/\{version:apiVersion\}/gi, version) : named
  ATTR_RE.lastIndex = 0
  for (let m = ATTR_RE.exec(file.text); m; m = ATTR_RE.exec(file.text)) {
    const sub = m[2] ?? ''
    // An absolute action route ("/health") replaces the prefix rather than
    // extending it, exactly as ASP.NET routing treats a leading slash.
    const template = sub.startsWith('/') ? sub : joinPath(prefix, sub)
    add(m[1].toUpperCase(), template, file.path, m.index, file.text)
  }
}

/** A .http file: one request per `GET https://host/path` line. */
function scanHttpFile(file: { path: string; text: string }, add: AddRoute): void {
  let offset = 0
  for (const line of file.text.split('\n')) {
    const m = /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i.exec(line)
    if (m) add(m[1].toUpperCase(), stripOrigin(m[2]), file.path, offset, file.text)
    offset += line.length + 1
  }
}

/** Drop scheme, host and any {{baseUrl}} variable, keeping path and query. */
function stripOrigin(raw: string): string {
  const withoutVar = raw.replace(/^\{\{[^}]*\}\}/, '')
  const schemed = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(withoutVar)
  return schemed ? (schemed[1] ?? '/') : withoutVar
}

function joinPath(prefix: string, sub: string): string {
  if (!prefix) return sub
  if (!sub) return prefix
  return `${prefix.replace(/\/+$/, '')}/${sub.replace(/^\/+/, '')}`
}

/** A leading slash, no double slashes, no trailing slash (except the root). */
function normalisePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const collapsed = withSlash.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/**
 * The verdict on one response, decided here and nowhere else.
 *
 * Called only when a response actually arrived: a call that never completed is
 * 'not_run' with the transport error, which is not the same as a failure of the
 * endpoint and must never be reported as one.
 */
export function checkCall(
  expect: ApiExpect,
  status: number,
  body: string | null,
): { outcome: 'pass' | 'fail'; detail: string | null } {
  if (expect.status !== null && status !== expect.status) {
    return { outcome: 'fail', detail: `expected ${expect.status}, got ${status}` }
  }
  if (expect.status === null && (status < 200 || status > 299)) {
    return { outcome: 'fail', detail: `expected a 2xx, got ${status}` }
  }
  if (expect.minItems !== null) {
    const items = jsonArrayLength(body)
    if (items === null) {
      return {
        outcome: 'fail',
        detail: `expected a JSON array of at least ${expect.minItems}, but the body is not an array`,
      }
    }
    if (items < expect.minItems) {
      return { outcome: 'fail', detail: `expected at least ${expect.minItems} items, got ${items}` }
    }
  }
  if (expect.mustContain && !(body ?? '').includes(expect.mustContain)) {
    return { outcome: 'fail', detail: `the response does not contain "${expect.mustContain}"` }
  }
  return { outcome: 'pass', detail: null }
}

/**
 * The length of the array in the body, or null when there is no array to count.
 * A wrapped collection ({"items": [...]}) counts its single array property, since
 * paged APIs are the common case and unwrapping it by hand would be the developer
 * doing the app's job.
 */
function jsonArrayLength(body: string | null): number | null {
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return parsed.length
  if (typeof parsed === 'object' && parsed !== null) {
    const arrays = Object.values(parsed).filter(Array.isArray)
    if (arrays.length === 1) return arrays[0].length
  }
  return null
}

/**
 * A run's verdict: every call passed, or it failed. A run where nothing ran at
 * all is an error rather than a pass — an empty eval set proves nothing.
 *
 * A single call that never completed is enough to take PASS away, and that is the
 * point rather than pedantry. The badge and the report headline are what a
 * developer reads, and a run of five endpoints where one answered and four timed
 * out is not a passing API: it is a run that mostly did not happen. It reports as
 * an error, with the per-call detail saying which calls never went out — the same
 * rule the verification side already follows, where nothing measured is never
 * reported as something proved.
 */
export function apiVerdict(calls: readonly ApiCall[]): ApiRunStatus {
  if (calls.length === 0) return 'error'
  if (calls.some((c) => c.outcome === 'fail')) return 'fail'
  if (calls.some((c) => c.outcome === 'not_run')) return 'error'
  return 'pass'
}

/** The endpoints most recently tested, newest first — the section's default list. */
export function recentEndpoints(
  runs: readonly ApiEvalRun[],
  limit = 5,
): { method: string; template: string }[] {
  const seen = new Map<string, { method: string; template: string }>()
  for (const run of runs) {
    for (const call of run.calls) {
      const key = `${call.request.method} ${call.request.template}`
      if (!seen.has(key)) {
        seen.set(key, { method: call.request.method, template: call.request.template })
      }
      if (seen.size >= limit) return [...seen.values()]
    }
  }
  return [...seen.values()]
}

/** Endpoints matching a search term, capped so the list stays a list. */
export function searchEndpoints(
  endpoints: readonly DiscoveredEndpoint[],
  term: string,
  limit = 40,
): DiscoveredEndpoint[] {
  const needle = term.trim().toLowerCase()
  if (!needle) return endpoints.slice(0, limit)
  return endpoints
    .filter(
      (e) =>
        e.template.toLowerCase().includes(needle) ||
        e.method.toLowerCase() === needle ||
        e.source.toLowerCase().includes(needle),
    )
    .slice(0, limit)
}
