import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

const PROJECT_FIELDS = [
  {
    name: 'project',
    label: 'Project',
    description: 'The Azure DevOps project to query.',
    kind: 'enum',
    required: true,
    options: [
      { value: 'Einstein Renewal', label: 'Einstein Renewal' },
      { value: 'A Plus', label: 'A Plus' },
    ],
    initial: null,
    why: null,
  },
  { name: 'top', label: 'How many', description: null, kind: 'integer', required: false, options: [], initial: 5, why: null },
  { name: 'closed', label: 'Include closed', description: null, kind: 'boolean', required: false, options: [], initial: null, why: null },
  {
    name: 'tags',
    label: 'Tags',
    description: null,
    kind: 'unsupported',
    required: false,
    options: [],
    initial: null,
    why: 'Switchboard cannot fill in a list here, so the answer leaves it out.',
  },
]

test('a link Switchboard did not open shows in full, opens only on Open, and Cancel before that answers the server', async ({ page }) => {
  const url = 'https://sso.example.com/start?client=abc&state=1'
  const id = await page.evaluate(
    (link) =>
      window.__mock.raiseElicitation({
        sessionId: 's-alpha',
        projectId: 'p-alpha',
        mode: 'url',
        server: 'Microsoft',
        serverName: 'tools',
        host: 'sso.example.com',
        path: '/start',
        url: link,
      }),
    url,
  )
  const card = page.getByTestId('inbox-view').getByTestId('elicitation-card')
  await expect(card.getByTestId('elicitation-consent')).toHaveText(
    'tools asks you to open a page on sso.example.com. Check the whole link first: Switchboard opens it only when you press Open.',
  )
  await expect(card.getByTestId('elicitation-url')).toHaveText(url)
  await expect(card.getByTestId('elicitation-host')).toHaveCount(0)
  await expect(card.getByTestId('elicitation-cancel')).toHaveText('Cancel')

  await card.getByTestId('elicitation-open').click()
  await expect(card.getByTestId('elicitation-host')).toContainText('Opened sso.example.com in your browser.')
  await expect(card.getByTestId('elicitation-url')).toHaveCount(0)
  await expect(card.getByTestId('elicitation-open-again')).toBeVisible()
  expect((await page.evaluate(() => window.__mock.state())).elicitationOpens).toEqual([id])

  const other = await page.evaluate(() =>
    window.__mock.raiseElicitation({ sessionId: 's-beta', projectId: 'p-beta', mode: 'url', host: 'sso.example.com', url: 'https://sso.example.com/b' }),
  )
  await page.getByTestId('inbox-view').locator(`[data-elicitation-id="${other}"]`).getByTestId('elicitation-cancel').click()
  expect((await page.evaluate(() => window.__mock.state())).elicitationAnswers).toEqual([{ id: other, action: 'cancel' }])
  expect((await page.evaluate(() => window.__mock.state())).elicitationOpens).toEqual([id])
})

test('clicking a sign-in notification opens a collapsed Inbox on its card', async ({ page }) => {
  await page.getByTestId('inbox-collapse').click()
  await expect(page.getByTestId('inbox-view')).toHaveCount(0)
  const id = await page.evaluate(() =>
    window.__mock.raiseElicitation({ sessionId: 's-beta', projectId: 'p-beta', mode: 'url', host: 'login.microsoftonline.com' }),
  )
  await page.evaluate((requestId) => window.__mock.focusInbox(requestId), id)
  await expect(page.getByTestId('inbox-view').locator(`[data-elicitation-id="${id}"]`)).toBeInViewport()
})

test('a sign-in request shows in the Inbox and the session stream with the server, the tool call and the host, and Hide clears it', async ({ page }) => {
  const id = await page.evaluate(() =>
    window.__mock.raiseElicitation({
      sessionId: 's-alpha',
      projectId: 'p-alpha',
      mode: 'url',
      server: 'Azure DevOps',
      serverName: 'ado',
      message: 'Sign in to Azure DevOps to continue.',
      host: 'login.microsoftonline.com',
      path: '/common/oauth2/v2.0/authorize',
      intent: { tool: 'core_list_projects', summary: 'core_list_projects: top 1' },
    }),
  )

  const card = page.getByTestId('inbox-view').getByTestId('elicitation-card')
  await expect(card).toHaveAttribute('data-mode', 'url')
  await expect(card.getByTestId('elicitation-server')).toHaveText('Azure DevOps (ado)')
  await expect(card.getByTestId('elicitation-title')).toHaveText('Azure DevOps wants you to sign in')
  await expect(card).toContainText('alpha')
  await expect(card.getByTestId('elicitation-message')).toHaveText('Sign in to Azure DevOps to continue.')
  await expect(card.getByTestId('elicitation-intent')).toHaveText('Asked while running core_list_projects: top 1')
  await expect(card.getByTestId('elicitation-host')).toContainText('Opened login.microsoftonline.com in your browser.')
  await expect(page.getByTestId('inbox-badge')).toHaveText('1')
  await expect(page.getByTestId('inbox-zero')).toHaveCount(0)
  await expect(page.getByTestId('status-badge-alpha')).toHaveAttribute('data-status', 'needs_you')

  const inStream = page.getByTestId('stream').getByTestId('elicitation-card')
  await expect(inStream).toBeVisible()

  await card.getByTestId('elicitation-open-again').click()
  await expect.poll(async () => (await page.evaluate(() => window.__mock.state())).elicitationOpens).toEqual([id])

  await expect(card.getByTestId('elicitation-hide-note')).toHaveText(
    'Hide only removes this card. The call keeps waiting until ado gives up; stop the session to end it now.',
  )
  await expect(card.getByTestId('elicitation-cancel')).toHaveText('Hide')
  await card.getByTestId('elicitation-cancel').click()
  await expect(page.getByTestId('elicitation-card')).toHaveCount(0)
  await expect(page.getByTestId('inbox-zero')).toBeVisible()
  expect((await page.evaluate(() => window.__mock.state())).elicitationAnswers).toEqual([{ id, action: 'cancel' }])
})

test('a refused link says why, offers no Open again, and is dismissed', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.raiseElicitation({
      sessionId: 's-beta',
      projectId: 'p-beta',
      mode: 'url',
      host: 'login.example.com',
      path: '/authorize',
      refused: 'The link is http, not https, so Switchboard did not open it.',
    }),
  )
  const card = page.getByTestId('inbox-view').getByTestId('elicitation-card')
  await expect(card.getByTestId('elicitation-refused')).toHaveText('The link is http, not https, so Switchboard did not open it.')
  await expect(card.getByTestId('elicitation-open-again')).toHaveCount(0)
  await card.getByTestId('elicitation-cancel').click()
  await expect(page.getByTestId('elicitation-card')).toHaveCount(0)
})

test('a form request shows each field, refuses a missing required one, and sends the answer', async ({ page }) => {
  const id = await page.evaluate(
    (fields) =>
      window.__mock.raiseElicitation({
        sessionId: 's-alpha',
        projectId: 'p-alpha',
        mode: 'form',
        message: 'Choose the project for this query.',
        title: 'Project selection',
        intent: { tool: 'wit_query', summary: 'wit_query: Features assigned to you' },
        fields,
      }),
    PROJECT_FIELDS,
  )
  const card = page.getByTestId('inbox-view').getByTestId('elicitation-card')
  await expect(card).toHaveAttribute('data-mode', 'form')
  await expect(card.getByTestId('elicitation-title')).toHaveText('Project selection')
  await expect(card.getByTestId('elicitation-intent')).toContainText('wit_query: Features assigned to you')
  await expect(card.getByTestId('elicitation-field-top')).toHaveValue('5')
  await expect(card.getByTestId('elicitation-field-tags')).toContainText('Switchboard cannot fill in a list here')

  await card.getByTestId('elicitation-accept').click()
  await expect(card.getByTestId('elicitation-error')).toHaveText('Project is required.')

  await card.getByTestId('elicitation-field-project').selectOption('A Plus')
  await card.getByTestId('elicitation-field-closed').check()
  await card.getByTestId('elicitation-accept').click()
  await expect(page.getByTestId('elicitation-card')).toHaveCount(0)
  const answers = (await page.evaluate(() => window.__mock.state())).elicitationAnswers
  expect(answers).toEqual([{ id, action: 'accept', values: { project: 'A Plus', top: 5, closed: true } }])
})

test('Decline answers a form request without sending any values', async ({ page }) => {
  const id = await page.evaluate(
    (fields) => window.__mock.raiseElicitation({ sessionId: 's-alpha', projectId: 'p-alpha', mode: 'form', fields }),
    PROJECT_FIELDS,
  )
  await page.getByTestId('inbox-view').getByTestId('elicitation-decline').click()
  await expect(page.getByTestId('elicitation-card')).toHaveCount(0)
  expect((await page.evaluate(() => window.__mock.state())).elicitationAnswers).toEqual([{ id, action: 'decline' }])
})

test('a Flow session’s request shows in the Flow popup, and a completed sign-in closes it', async ({ page }) => {
  await page.getByTestId('open-flow').click()
  await expect(page.getByTestId('flow-popup')).toBeVisible()
  const id = await page.evaluate(() =>
    window.__mock.raiseElicitation({
      sessionId: 's-alpha',
      projectId: 'p-alpha',
      flow: true,
      mode: 'url',
      server: 'ado',
      host: 'login.microsoftonline.com',
      path: '/authorize',
      intent: { tool: 'wit_query', summary: 'wit_query: Features assigned to you in Einstein Renewal' },
    }),
  )
  const card = page.getByTestId('flow-popup-asks').getByTestId('elicitation-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('elicitation-intent')).toContainText('wit_query: Features assigned to you in Einstein Renewal')
  await page.evaluate((done) => window.__mock.completeElicitation(done), id)
  await expect(page.getByTestId('flow-popup-asks')).toHaveCount(0)
})

test('a request from a session outside Flow stays out of the Flow popup', async ({ page }) => {
  await page.getByTestId('open-flow').click()
  await page.evaluate(() => window.__mock.raiseElicitation({ sessionId: 's-alpha', projectId: 'p-alpha', mode: 'form' }))
  await expect(page.getByTestId('inbox-view').getByTestId('elicitation-card')).toHaveCount(1)
  await expect(page.getByTestId('flow-popup-asks')).toHaveCount(0)
})
