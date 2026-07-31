// The one question a model is asked in an API run: what data to send.
//
// Not "test the endpoints", not "report whether they work" — only which real
// identifiers exist and what the response should therefore say. The app makes the
// calls, reads the statuses, and decides pass or fail (api-runner.ts), because
// those are facts a program can establish and a narrated result is not.
//
// The reason the model is in the loop at all: an endpoint called with an invented
// id answers 200 with an empty body and looks healthy, so the inputs have to come
// from rows that actually exist. Only the project's database knows which ones do.
import type { ApiExpect, ApiRequestPlan, ApiTarget } from '@shared/api-endpoints'

/** Sentinel the session emits once, on its own line. */
export const API_DATA_MARKER = 'SWB_APIDATA'

const SCHEMA = `{
  "requests": [{
    "template": "<the route template you were given, verbatim>",
    "method": "GET|POST|PUT|PATCH|DELETE",
    "path": "<the concrete path, real values substituted, query string included>",
    "body": "<JSON string for the request body, or null>",
    "headers": {"<name>": "<value>"} or null,
    "expect": {
      "status": <the status this call should return, or null for any 2xx>,
      "minItems": <the response must be a JSON array of at least this many items, or null>,
      "mustContain": "<text the body must contain verbatim, or null>"
    },
    "note": "<what the real data proves, e.g. 'customer 4417 has 3 contracts'>",
    "dataSource": "<the MCP server the identifiers came from, or null>",
    "dataQuery": "<the query you ran to get them, verbatim, or null>"
  }]
}`

/**
 * Which environment the calls are bound for.
 *
 * It changes the data, not just the URL. A QA environment has its own database,
 * so an id read from a local one is worthless there, and it is shared with other
 * people, so a write nobody sanctioned is not a test — it is an incident. Both
 * facts have to reach the session that chooses the identifiers, because by the
 * time the app is sending requests it is too late to choose different ones.
 */
function environmentSection(environment: { target: ApiTarget; baseUrl: string }): string {
  if (environment.target !== 'qa') return ''
  return (
    `These calls go to a DEPLOYED QA environment: ${environment.baseUrl}. It is shared, it is ` +
    'already running, and the application will not start or stop anything.\n' +
    '- Read the identifiers from the database that environment uses, not a local one. If the ' +
    'connected server points somewhere else, say so in "note" and leave the endpoint out rather ' +
    'than sending an id that does not exist there.\n' +
    '- Cover READS. Do not plan a write, a delete or anything that changes state in a shared ' +
    'environment unless the endpoint under test is itself the write and you say in "note" why it ' +
    'is safe there.\n' +
    '- The application already attaches the headers that environment needs, so do not invent an ' +
    'API key or a token. Set "headers" only for a case that deliberately tests missing or wrong ' +
    'auth.\n\n'
  )
}

/**
 * Ask for request data for the chosen endpoints, and for nothing else.
 *
 * The prohibitions are the point of this prompt. Every previous version of this
 * feature asked the session to run the test and report the outcome, which is the
 * part being removed: a reported status is a claim, whereas a status the app
 * received is evidence.
 */
export function apiDataPrompt(
  endpoints: readonly { method: string; template: string }[],
  dbServers: readonly string[],
  /** Which environment the app will send these to, so the data matches it. */
  environment: { target: ApiTarget; baseUrl: string } = { target: 'local', baseUrl: '' },
): string {
  const named = dbServers.length > 0
  return (
    'Produce the request data for an automated API test. The application will send these ' +
    'requests itself and judge the responses itself.\n\n' +
    'Do NOT call any endpoint. Do NOT start the application. Do NOT run the tests. Do NOT ' +
    'edit any file. Your entire job is to say what to send and what the answer should be.\n\n' +
    environmentSection(environment) +
    'The endpoints to cover:\n' +
    endpoints.map((e) => `- ${e.method} ${e.template}`).join('\n') +
    '\n\n' +
    (named
      ? `Get the identifiers from the connected database MCP server(s): ${dbServers.join(', ')}.\n` +
        '- Read the schema through that server before you query it, and write SQL in ITS ' +
        'dialect. Do not guess a table or column name from entity names, and do not assume the ' +
        'syntax of a different engine: an Oracle server does not take LIMIT. A guessed table ' +
        'name fails in a way that looks like the API is broken when it is not.\n' +
        '- Substitute real values into every route parameter. An id that does not exist makes ' +
        'the whole call worthless, because an empty 200 then reads as a pass.\n' +
        '- Set "expect" from the data you just read, so the check is real: if the row count for ' +
        'that customer is 3, set "minItems" to 3; if a name is on the row, put it in ' +
        '"mustContain". Record the query verbatim in "dataQuery".\n' +
        // The strongest check this feature can make, and it only exists for the
        // EF Core path: when the endpoint's own answer IS a query, that query can
        // be run directly and the response checked against its rows. A stored
        // procedure cannot be reproduced that way, so it is not pretended.
        '- If the endpoint is served by EF Core — a LINQ query over a DbContext rather than a ' +
        'stored procedure — open that query, reproduce it as SQL through the same server, and ' +
        'set "expect" from the rows it returns: the count as "minItems", a value off the first ' +
        'row as "mustContain". Say in "note" what those rows prove. That makes the check a ' +
        'comparison against the data rather than a look at a status code. If the endpoint calls ' +
        'a stored procedure instead, say so in "note" and expect only what the procedure ' +
        'contract states — do not reproduce a procedure as SQL.\n'
      : 'No database MCP server is connected for this project, so you have no source of real ' +
        'identifiers.\n' +
        '- Use whatever the project itself provides: a seed script, an .http file, appsettings, ' +
        'a fixture. Set "dataSource" and "dataQuery" to null so it is clear the inputs were not ' +
        'drawn from real data.\n' +
        '- Keep "expect" to what you can justify: a status, and "minItems"/"mustContain" only ' +
        'when the project itself tells you what the answer holds.\n') +
    '- Add one request per endpoint that SHOULD fail — a missing id, absent auth — with the ' +
    'status it should return (404, 401). An API that answers 200 for a deleted record is ' +
    'exactly what this catches.\n' +
    '- For a write endpoint, only send a body if the project clearly points at a test ' +
    'database. If in doubt, cover the reads and leave the write out.\n\n' +
    'Every value must come from something you actually read. If you could not find real data ' +
    'for an endpoint, leave that endpoint out entirely rather than inventing an id — a missing ' +
    'request is honest, an invented one produces a green result that means nothing.\n\n' +
    `Finish your reply with one line, on its own, starting with ${API_DATA_MARKER}: followed by ` +
    `JSON of this shape (one line, no code fence):\n${SCHEMA}`
  )
}

/**
 * Read the request plans out of session text. Tolerant on the way in, strict on
 * the way out: a request missing a method or a path is dropped rather than
 * repaired, and an unparseable expectation becomes "any 2xx" rather than a
 * condition that silently passes.
 *
 * The LAST marker wins — the prompt above names the sentinel, and a turn may
 * restate it, so an early mention must never be read as the answer.
 */
export function parseApiRequests(text: string): ApiRequestPlan[] | null {
  const at = text.lastIndexOf(`${API_DATA_MARKER}:`)
  if (at < 0) return null
  const tail = text.slice(at + API_DATA_MARKER.length + 1)
  const start = tail.indexOf('{')
  const end = tail.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(tail.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const list = (raw as { requests?: unknown }).requests
  if (!Array.isArray(list)) return null
  return list.map(toRequestPlan).filter((r): r is ApiRequestPlan => r !== null)
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function toRequestPlan(raw: unknown): ApiRequestPlan | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const method = str(record.method)?.toUpperCase()
  const path = str(record.path)
  if (!method || !METHODS.has(method) || !path) return null
  return {
    template: str(record.template) ?? path,
    method,
    path: path.startsWith('/') ? path : `/${path}`,
    body: str(record.body),
    headers: toHeaders(record.headers),
    expect: toExpect(record.expect),
    note: str(record.note),
    dataSource: str(record.dataSource),
    dataQuery: str(record.dataQuery),
  }
}

function toExpect(raw: unknown): ApiExpect {
  if (typeof raw !== 'object' || raw === null) {
    return { status: null, minItems: null, mustContain: null }
  }
  const record = raw as Record<string, unknown>
  return {
    status: int(record.status),
    minItems: int(record.minItems),
    mustContain: str(record.mustContain),
  }
}

/** Only string headers survive; anything else would fail at the fetch boundary. */
function toHeaders(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const text = str(value)
    if (text) out[key] = text
  }
  return Object.keys(out).length > 0 ? out : null
}

function str(value: unknown): string | null {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && !/^(null|n\/a|none|unknown)$/i.test(trimmed) ? trimmed : null
}

function int(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value !== 'string') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}
