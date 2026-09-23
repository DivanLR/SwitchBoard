import type {
  Elicitation,
  ElicitationAnswer,
  ElicitationField,
  ElicitationValues,
  ToolIntent,
} from '@shared/domain'
import type { IpcError } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
import type { ElicitationGate, ElicitationRequest, ElicitationResult, ToolCall } from '@main/sessions/session'

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const invalid = (message: string): IpcError => ({ code: 'INVALID_PATH', message })

export function redactUrls(value: string): string {
  return value.replace(/(https?:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
}

export function checkSignInUrl(raw: string | undefined): {
  host: string | null
  path: string | null
  refused: string | null
} {
  if (!raw || !URL.canParse(raw)) {
    return { host: null, path: null, refused: 'The server sent no link Switchboard can read, so nothing was opened.' }
  }
  const url = new URL(raw)
  const at = { host: url.host || null, path: url.pathname || null }
  if (url.protocol !== 'https:') {
    return { ...at, refused: `The link is ${url.protocol.slice(0, -1)}, not https, so Switchboard did not open it.` }
  }
  if (url.username || url.password) {
    return { ...at, refused: 'The link carries a user name or password, so Switchboard did not open it.' }
  }
  return { ...at, refused: null }
}

function choices(prop: Record<string, unknown>): { value: string; label: string }[] | null {
  if (Array.isArray(prop.oneOf)) {
    const list = prop.oneOf
      .filter(isRecord)
      .filter((option) => option.const !== undefined)
      .map((option) => ({ value: String(option.const), label: text(option.title) ?? String(option.const) }))
    return list.length > 0 ? list : null
  }
  if (!Array.isArray(prop.enum) || prop.enum.length === 0) return null
  const names: unknown[] = Array.isArray(prop.enumNames) ? prop.enumNames : []
  return prop.enum.map((value, at) => ({ value: String(value), label: text(names[at]) ?? String(value) }))
}

function field(name: string, prop: Record<string, unknown>, required: boolean): ElicitationField {
  const type = prop.type
  const initial =
    typeof prop.default === 'string' || typeof prop.default === 'number' || typeof prop.default === 'boolean'
      ? prop.default
      : null
  const base = { name, label: text(prop.title) ?? name, description: text(prop.description), required, options: [], initial, why: null }
  const listed = type === 'array' ? null : choices(prop)
  if (listed) return { ...base, kind: 'enum', options: listed }
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return { ...base, kind: type }
  const what = type === 'array' ? 'a list' : typeof type === 'string' ? `a ${type}` : 'this kind of value'
  return {
    ...base,
    kind: 'unsupported',
    why: required
      ? `Switchboard cannot fill in ${what} here, and the server requires it, so Send is off. Decline, or answer it in the Terminal.`
      : `Switchboard cannot fill in ${what} here, so the answer leaves it out.`,
  }
}

export function formFields(schema: Record<string, unknown> | undefined): ElicitationField[] {
  const properties = isRecord(schema?.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((n) => typeof n === 'string') : [])
  return Object.entries(properties).map(([name, prop]) => field(name, isRecord(prop) ? prop : {}, required.has(name)))
}

export function formContent(fields: ElicitationField[], values: ElicitationValues = {}): ElicitationValues {
  const content: ElicitationValues = {}
  for (const f of fields) {
    const raw = values[f.name]
    if (f.kind === 'unsupported' || raw === undefined || raw === '') {
      if (!f.required) continue
      throw invalid(f.kind === 'unsupported' ? `${f.label} cannot be filled in here.` : `${f.label} is required.`)
    }
    if (f.kind === 'boolean') {
      content[f.name] = raw === true || raw === 'true'
    } else if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(raw)
      if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) {
        throw invalid(`${f.label} must be ${f.kind === 'integer' ? 'a whole number' : 'a number'}.`)
      }
      content[f.name] = n
    } else if (f.kind === 'enum') {
      if (!f.options.some((option) => option.value === String(raw))) {
        throw invalid(`${f.label} must be one of the listed choices.`)
      }
      content[f.name] = String(raw)
    } else {
      content[f.name] = String(raw)
    }
  }
  return content
}

function describeInput(input: Record<string, unknown>): string | null {
  const wiql = text(input.wiql) ?? text(input.query)
  if (wiql && /\bselect\b/i.test(wiql)) {
    const type = /WorkItemType\]\s*=\s*'([^']+)'/i.exec(wiql)?.[1]
    const what = type ? `${type}s` : 'work items'
    return /@me\b/i.test(wiql) ? `${what} assigned to you` : what
  }
  if (Array.isArray(input.ids) && input.ids.length > 0) {
    return `${input.ids.length} work item${input.ids.length === 1 ? '' : 's'}`
  }
  if (typeof input.id === 'string' || typeof input.id === 'number') return `item ${input.id}`
  const action = text(input.action)
  if (action) return action
  const pairs = Object.entries(input)
    .filter(([key, value]) => key !== 'project' && ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 2)
    .map(([key, value]) => `${key} ${String(value)}`)
  return pairs.length > 0 ? pairs.join(', ') : null
}

export function toolIntent(toolName: string, input: Record<string, unknown>): ToolIntent {
  const tool = toolName.split('__').slice(2).join('__') || toolName
  const project = text(input.project)
  const summary = [describeInput(input), project ? `in ${project}` : null].filter(Boolean).join(' ')
  const line = redactUrls(summary ? `${tool}: ${summary}` : tool)
  return { tool, summary: line.length > 140 ? `${line.slice(0, 139)}…` : line }
}

function headline(item: Elicitation): string {
  return item.title ?? (item.mode === 'url' ? `${item.server} wants you to sign in` : `${item.server} needs an answer`)
}

interface Attention {
  attentionRaised(sessionId: string): void
  attentionCleared(sessionId: string): void
}

interface ElicitationCallbacks {
  onChanged: (pending: Elicitation[]) => void
  onNeedsYou: (context: { projectId: string; sessionId: string; kind: 'sign_in' | 'input'; title: string }) => void
  openExternal: (url: string) => unknown
}

interface Entry {
  item: Elicitation
  url: string | null
  elicitationId: string | null
  toolUseId: string | null
  attention: boolean
  settle: ((result: ElicitationResult) => void) | null
}

const GONE: IpcError = { code: 'NOT_FOUND', message: 'That request was already answered, or its session ended.' }

export class ElicitationBroker implements ElicitationGate {
  private entries = new Map<string, Entry>()

  constructor(
    private repos: Repositories,
    private sessions: Attention,
    private callbacks: ElicitationCallbacks,
  ) {}

  pending(): Elicitation[] {
    return [...this.entries.values()].map((entry) => entry.item)
  }

  request(context: {
    sessionId: string
    request: ElicitationRequest
    signal: AbortSignal
    trigger: ToolCall | null
  }): Promise<ElicitationResult> {
    const { sessionId, request, signal, trigger } = context
    const session = this.repos.sessions.byId(sessionId)
    if (!session || signal.aborted) return Promise.resolve({ action: 'cancel' })
    const url = request.mode === 'url'
    const link = url ? checkSignInUrl(request.url) : null
    const item: Elicitation = {
      id: newId(),
      sessionId,
      projectId: session.projectId,
      flow: session.sectionKind === 'flow',
      server: text(request.displayName) ?? request.serverName,
      serverName: request.serverName,
      mode: url ? 'url' : 'form',
      message: redactUrls(request.message ?? ''),
      title: text(request.title) ? redactUrls(request.title as string) : null,
      description: text(request.description) ? redactUrls(request.description as string) : null,
      intent: trigger ? toolIntent(trigger.tool, trigger.input) : null,
      host: link?.host ?? null,
      path: link?.path ?? null,
      refused: link?.refused ?? null,
      fields: url ? [] : formFields(request.requestedSchema),
      createdAt: nowIso(),
    }
    const entry: Entry = {
      item,
      url: url && !item.refused ? (request.url ?? null) : null,
      elicitationId: request.elicitationId ?? null,
      toolUseId: trigger?.toolUseId ?? null,
      attention: !item.refused,
      settle: null,
    }
    this.entries.set(item.id, entry)
    if (entry.attention) this.sessions.attentionRaised(sessionId)
    this.callbacks.onChanged(this.pending())
    if (item.refused) return Promise.resolve({ action: 'decline' })
    this.callbacks.onNeedsYou({ projectId: item.projectId, sessionId, kind: url ? 'sign_in' : 'input', title: headline(item) })
    signal.addEventListener('abort', () => this.finish(item.id, { action: 'cancel' }), { once: true })
    if (url) {
      this.open(entry)
      return Promise.resolve({ action: 'accept' })
    }
    return new Promise((resolve) => {
      entry.settle = resolve
    })
  }

  respond(id: string, action: ElicitationAnswer, values?: ElicitationValues): void {
    const entry = this.entries.get(id)
    if (!entry) throw GONE
    if (!['accept', 'decline', 'cancel'].includes(action)) throw invalid('Answer with accept, decline or cancel.')
    if (action !== 'accept' || entry.item.mode === 'url') {
      this.finish(id, { action })
      return
    }
    this.finish(id, { action: 'accept', content: formContent(entry.item.fields, values) })
  }

  openAgain(id: string): void {
    const entry = this.entries.get(id)
    if (!entry?.url) throw GONE
    this.open(entry)
  }

  completed(sessionId: string, serverName: string, elicitationId: string): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.item.sessionId === sessionId && entry.item.serverName === serverName && entry.elicitationId === elicitationId) {
        this.finish(id, { action: 'accept' })
      }
    }
  }

  toolFinished(sessionId: string, toolUseId: string): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.item.sessionId === sessionId && entry.toolUseId === toolUseId) this.finish(id, { action: 'cancel' })
    }
  }

  endForSession(sessionId: string): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.item.sessionId === sessionId) this.finish(id, { action: 'cancel' })
    }
  }

  private open(entry: Entry): void {
    if (!entry.url) return
    try {
      void Promise.resolve(this.callbacks.openExternal(entry.url)).catch(() => {})
    } catch {}
  }

  private finish(id: string, result: ElicitationResult): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.settle?.(result)
    if (entry.attention) this.sessions.attentionCleared(entry.item.sessionId)
    this.callbacks.onChanged(this.pending())
  }
}
