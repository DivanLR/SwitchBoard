export interface DiscoveredEndpoint {
  method: string
  template: string
  source: string
}

export interface ApiExpect {
  status: number | null
  minItems: number | null
  mustContain: string | null
}

export interface ApiRequestPlan {
  template: string
  method: string
  path: string
  body: string | null
  headers: Record<string, string> | null
  expect: ApiExpect
  note: string | null
  dataSource: string | null
  dataQuery: string | null
}

export interface ApiCall {
  request: ApiRequestPlan
  status: number | null
  ms: number | null
  body: string | null
  outcome: 'pass' | 'fail' | 'not_run'
  detail: string | null
}

type ApiRunStatus = 'running' | 'pass' | 'fail' | 'error'

export type ApiTarget = 'local' | 'qa'

export interface ApiEvalRun {
  id: string
  projectId: string
  baseUrl: string
  target: ApiTarget
  launched: boolean
  sessionId: string | null
  status: ApiRunStatus
  note: string | null
  calls: ApiCall[]
  startedAt: string
  finishedAt: string | null
}

const PATTERNS: readonly { re: RegExp; method?: string }[] = [
  { re: /\bMap(Get|Post|Put|Patch|Delete)\s*(?:<[^()>]*>)?\s*\(\s*"([^"]*)"/g },
  { re: /\b(?:app|router|server)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g },
]

const ATTR_RE = /\[Http(Get|Post|Put|Patch|Delete)(?:\s*\(\s*"([^"]*)"\s*\))?/g

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

function scanAttributes(file: { path: string; text: string }, add: AddRoute): void {
  const controller = /\bclass\s+(\w+?)Controller\b/.exec(file.text)?.[1] ?? null
  const routeAttr = /\[Route\s*\(\s*"([^"]*)"\s*\)\s*\]/.exec(file.text)?.[1] ?? ''
  const version = /\[ApiVersion\s*\(\s*"([^"]+)"/.exec(file.text)?.[1] ?? null
  const named = controller ? routeAttr.replace(/\[controller\]/gi, controller) : routeAttr
  const prefix = version ? named.replace(/\{version:apiVersion\}/gi, version) : named
  ATTR_RE.lastIndex = 0
  for (let m = ATTR_RE.exec(file.text); m; m = ATTR_RE.exec(file.text)) {
    const sub = m[2] ?? ''
    const template = sub.startsWith('/') ? sub : joinPath(prefix, sub)
    add(m[1].toUpperCase(), template, file.path, m.index, file.text)
  }
}

function scanHttpFile(file: { path: string; text: string }, add: AddRoute): void {
  let offset = 0
  for (const line of file.text.split('\n')) {
    const m = /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i.exec(line)
    if (m) add(m[1].toUpperCase(), stripOrigin(m[2]), file.path, offset, file.text)
    offset += line.length + 1
  }
}

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

export function apiVerdict(calls: readonly ApiCall[]): ApiRunStatus {
  if (calls.length === 0) return 'error'
  if (calls.some((c) => c.outcome === 'fail')) return 'fail'
  if (calls.some((c) => c.outcome === 'not_run')) return 'error'
  return 'pass'
}

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
