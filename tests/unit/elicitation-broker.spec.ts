import { describe, expect, it } from 'vitest'
import type { Elicitation } from '@shared/domain'
import type { ElicitationRequest } from '@main/sessions/session'
import { openDatabase } from '@main/store/db'
import { createRepositories, newId, nowIso } from '@main/store/repositories'
import {
  ElicitationBroker,
  checkSignInUrl,
  formContent,
  formFields,
  redactUrls,
  toolIntent,
} from '@main/inbox/elicitation-broker'

function setup(section: 'flow' | null = null) {
  const repos = createRepositories(openDatabase(':memory:'))
  const project = repos.projects.insert({ name: 'alpha', path: 'C:\\alpha', source: 'manual' })
  const sessionId = newId()
  repos.sessions.insert({
    id: sessionId, projectId: project.id, engine: 'claude', sdkSessionId: null, status: 'working', statusDetail: null,
    branch: null, diffAdds: null, diffDels: null, usageUtilization: null, usageResetsAt: null, usageLimitType: null,
    startedAt: nowIso(), endedAt: null, endReason: null,
  })
  if (section) repos.sessions.update(sessionId, { sectionKind: section })
  const opened: string[] = []
  const attention: string[] = []
  const notified: { kind: string; title: string }[] = []
  let pending: Elicitation[] = []
  const broker = new ElicitationBroker(
    repos,
    {
      attentionRaised: (id) => attention.push(`+${id}`),
      attentionCleared: (id) => attention.push(`-${id}`),
    },
    {
      onChanged: (list) => (pending = list),
      onNeedsYou: (context) => notified.push({ kind: context.kind, title: context.title }),
      openExternal: (url) => opened.push(url),
    },
  )
  const ask = (request: Partial<ElicitationRequest>, signal = new AbortController().signal, trigger: Parameters<ElicitationBroker['request']>[0]['trigger'] = null) =>
    broker.request({ sessionId, request: { serverName: 'ado', message: 'Sign in', ...request }, signal, trigger })
  return { broker, sessionId, project, opened, attention, notified, ask, pending: () => pending }
}

const SIGN_IN = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&state=secret#frag'

describe('a url sign-in', () => {
  it('opens an https link at once, accepts, and keeps a card with the host and path but no query', async () => {
    const h = setup()
    await expect(h.ask({ mode: 'url', url: SIGN_IN, elicitationId: 'e-1', message: `Open ${SIGN_IN} to sign in` })).resolves.toEqual({ action: 'accept' })
    expect(h.opened).toEqual([SIGN_IN])
    const [card] = h.pending()
    expect(card).toMatchObject({
      mode: 'url',
      server: 'ado',
      host: 'login.microsoftonline.com',
      path: '/common/oauth2/v2.0/authorize',
      refused: null,
      message: 'Open https://login.microsoftonline.com/common/oauth2/v2.0/authorize to sign in',
    })
    expect(JSON.stringify(card)).not.toContain('secret')
    expect(h.attention).toEqual([`+${h.sessionId}`])
    expect(h.notified).toEqual([{ kind: 'sign_in', title: 'ado wants you to sign in' }])
  })

  it('opens it again on request, and closes the card when the server says the sign-in is complete', async () => {
    const h = setup()
    await h.ask({ mode: 'url', url: SIGN_IN, elicitationId: 'e-1' })
    const id = h.pending()[0].id
    h.broker.openAgain(id)
    expect(h.opened).toEqual([SIGN_IN, SIGN_IN])
    h.broker.completed(h.sessionId, 'ado', 'other')
    expect(h.pending()).toHaveLength(1)
    h.broker.completed(h.sessionId, 'ado', 'e-1')
    expect(h.pending()).toEqual([])
    expect(h.attention).toEqual([`+${h.sessionId}`, `-${h.sessionId}`])
  })

  it.each([
    ['http://login.example.com/authorize?code=1', 'The link is http, not https, so Switchboard did not open it.'],
    ['https://user:pass@login.example.com/authorize', 'The link carries a user name or password, so Switchboard did not open it.'],
    ['javascript:alert(1)', 'The link is javascript, not https, so Switchboard did not open it.'],
    [undefined, 'The server sent no link Switchboard can read, so nothing was opened.'],
  ])('refuses %s, opens nothing, declines, and shows why', async (url, why) => {
    const h = setup()
    await expect(h.ask({ mode: 'url', url })).resolves.toEqual({ action: 'decline' })
    expect(h.opened).toEqual([])
    expect(h.pending()[0].refused).toBe(why)
    expect(h.attention).toEqual([])
    h.broker.respond(h.pending()[0].id, 'cancel')
    expect(h.pending()).toEqual([])
  })

  it('closes when the session ends, when the tool call that asked finishes, or when the person cancels', async () => {
    const h = setup()
    await h.ask({ mode: 'url', url: SIGN_IN }, undefined, { toolUseId: 'tu-1', tool: 'mcp__ado__core_list_projects', input: { top: 1 } })
    h.broker.toolFinished(h.sessionId, 'tu-2')
    expect(h.pending()).toHaveLength(1)
    h.broker.toolFinished(h.sessionId, 'tu-1')
    expect(h.pending()).toEqual([])

    await h.ask({ mode: 'url', url: SIGN_IN })
    h.broker.endForSession(h.sessionId)
    expect(h.pending()).toEqual([])

    await h.ask({ mode: 'url', url: SIGN_IN })
    h.broker.respond(h.pending()[0].id, 'cancel')
    expect(h.pending()).toEqual([])
    expect(() => h.broker.respond('gone', 'cancel')).toThrow()
  })
})

describe('a form request', () => {
  const schema = {
    type: 'object',
    required: ['project', 'top'],
    properties: {
      project: { type: 'string', title: 'Project', enum: ['Einstein Renewal', 'A Plus'] },
      top: { type: 'integer', title: 'How many', default: 5 },
      ratio: { type: 'number' },
      closed: { type: 'boolean', title: 'Include closed' },
      note: { type: 'string', description: 'Anything else' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    },
  }

  it('shows each field, the unsupported one read-only with an explanation', () => {
    const fields = formFields(schema)
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ['project', 'enum', true],
      ['top', 'integer', true],
      ['ratio', 'number', false],
      ['closed', 'boolean', false],
      ['note', 'string', false],
      ['tags', 'unsupported', false],
    ])
    expect(fields[0].options).toEqual([
      { value: 'Einstein Renewal', label: 'Einstein Renewal' },
      { value: 'A Plus', label: 'A Plus' },
    ])
    expect(fields[1].initial).toBe(5)
    expect(fields[5].why).toBe('Switchboard cannot fill in a list here, so the answer leaves it out.')
    expect(formFields({ properties: { pick: { type: 'string', oneOf: [{ const: 'x', title: 'Ex' }] } } })[0].options).toEqual([
      { value: 'x', label: 'Ex' },
    ])
  })

  it('builds typed content from the fields and refuses a missing, wrong or unlisted value', () => {
    const fields = formFields(schema)
    expect(formContent(fields, { project: 'A Plus', top: '3', ratio: 0.5, closed: true, note: '', tags: 'a' })).toEqual({
      project: 'A Plus',
      top: 3,
      ratio: 0.5,
      closed: true,
    })
    expect(() => formContent(fields, { top: 3 })).toThrow(expect.objectContaining({ code: 'INVALID_PATH', message: 'Project is required.' }))
    expect(() => formContent(fields, { project: 'A Plus', top: '2.5' })).toThrow(expect.objectContaining({ message: 'How many must be a whole number.' }))
    expect(() => formContent(fields, { project: 'Other', top: 1 })).toThrow(expect.objectContaining({ message: 'Project must be one of the listed choices.' }))
    const required = formFields({ required: ['tags'], properties: { tags: { type: 'array' } } })
    expect(() => formContent(required, {})).toThrow(expect.objectContaining({ message: 'tags cannot be filled in here.' }))
  })

  it('returns accept with the content, decline or cancel from the choice, and blocks the session until then', async () => {
    const h = setup()
    const accepted = h.ask({ mode: 'form', requestedSchema: schema, message: 'Choose a project' })
    expect(h.notified).toEqual([{ kind: 'input', title: 'ado needs an answer' }])
    expect(h.attention).toEqual([`+${h.sessionId}`])
    const id = h.pending()[0].id
    expect(() => h.broker.respond(id, 'accept', { top: 1 })).toThrow()
    expect(h.pending()).toHaveLength(1)
    h.broker.respond(id, 'accept', { project: 'Einstein Renewal', top: 1 })
    await expect(accepted).resolves.toEqual({ action: 'accept', content: { project: 'Einstein Renewal', top: 1 } })
    expect(h.attention).toEqual([`+${h.sessionId}`, `-${h.sessionId}`])

    const declined = h.ask({ mode: 'form', requestedSchema: schema })
    h.broker.respond(h.pending()[0].id, 'decline')
    await expect(declined).resolves.toEqual({ action: 'decline' })

    const cancelled = h.ask({ requestedSchema: schema })
    h.broker.respond(h.pending()[0].id, 'cancel')
    await expect(cancelled).resolves.toEqual({ action: 'cancel' })
  })

  it('cancels when the SDK aborts the request or the session ends', async () => {
    const h = setup()
    const abort = new AbortController()
    const aborted = h.ask({ requestedSchema: schema }, abort.signal)
    abort.abort()
    await expect(aborted).resolves.toEqual({ action: 'cancel' })
    expect(h.pending()).toEqual([])

    const ended = h.ask({ requestedSchema: schema })
    h.broker.endForSession(h.sessionId)
    await expect(ended).resolves.toEqual({ action: 'cancel' })
    expect(h.pending()).toEqual([])
  })

  it('marks a Flow session so the Flow popup shows it, and names the tool call that asked', async () => {
    const h = setup('flow')
    void h.ask({ displayName: 'Azure DevOps', requestedSchema: schema }, undefined, {
      toolUseId: 'tu-9',
      tool: 'mcp__ado__wit_query',
      input: {
        action: 'wiql',
        top: 25,
        wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Feature' AND [System.AssignedTo] = @Me",
      },
    })
    expect(h.pending()[0]).toMatchObject({
      flow: true,
      server: 'Azure DevOps',
      serverName: 'ado',
      intent: { tool: 'wit_query', summary: 'wit_query: Features assigned to you' },
    })
  })
})

describe('the tool intent and the url checks', () => {
  it('summarises a tool call in a short readable line', () => {
    const wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Feature' AND [System.AssignedTo] = @Me"
    expect(toolIntent('mcp__ado__wit_query', { action: 'wiql', project: 'Einstein Renewal', wiql }).summary).toBe(
      'wit_query: Features assigned to you in Einstein Renewal',
    )
    expect(toolIntent('mcp__ado__core_list_projects', { top: 1 }).summary).toBe('core_list_projects: top 1')
    expect(toolIntent('mcp__ado__wit_work_item', { action: 'get_batch', project: 'A Plus', ids: [1, 2] }).summary).toBe(
      'wit_work_item: 2 work items in A Plus',
    )
    expect(toolIntent('mcp__ado__wit_my_work_items', {}).summary).toBe('wit_my_work_items')
    expect(toolIntent('mcp__web__fetch', { url: 'https://x.test/a?token=1' }).summary).toBe('fetch: url https://x.test/a')
  })

  it('strips the query string and fragment from every link in a text', () => {
    expect(redactUrls('Go to https://a.test/p?x=1&y=2 then http://b.test/#t and https://c.test/q')).toBe(
      'Go to https://a.test/p then http://b.test/ and https://c.test/q',
    )
  })

  it('keeps only the host and path of a link it will open', () => {
    expect(checkSignInUrl(SIGN_IN)).toEqual({
      host: 'login.microsoftonline.com',
      path: '/common/oauth2/v2.0/authorize',
      refused: null,
    })
  })
})
