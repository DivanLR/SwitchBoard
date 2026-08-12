// Diagrams section: the developer describes a diagram, the app asks the
// project's session for it (via the diagram-design plugin) and lists whatever
// lands in docs/diagrams. Follows specs.spec.ts / diff-tab.spec.ts for
// structure: installMockHost in beforeEach, select alpha, open the tab.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'
import { DIAGRAM_PLUGIN, DIAGRAMS_DIR } from '../../src/shared/diagram'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-diagrams').click()
  await expect(page.getByTestId('diagrams-view')).toBeVisible()
})

test('lists existing diagrams, newest first, with the file name and the session that made it', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mock.addDiagram('p-alpha', {
      file: 'auth-flow.html',
      path: 'docs/diagrams/auth-flow.html',
      description: 'Auth flow for login',
      sessionId: 's-alpha',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      bytes: 4200,
    })
    window.__mock.addDiagram('p-alpha', {
      file: 'billing-webhook.html',
      path: 'docs/diagrams/billing-webhook.html',
      description: 'Billing webhook sequence',
      sessionId: 's-alpha',
      modifiedAt: '2026-08-10T00:00:00.000Z',
      bytes: 5100,
    })
  })
  // Re-load the tab so the load() action reads the freshly seeded folder.
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('tab-diagrams').click()

  const rows = page.getByTestId(/^diagram-row-/)
  await expect(rows).toHaveCount(2)
  // Newest (billing-webhook, 08-10) first.
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'diagram-row-billing-webhook.html')
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'diagram-row-auth-flow.html')
  // The list is a way back to a diagram, so a row carries the name and nothing
  // else; the session that made it belongs to the one on screen.
  await expect(page.getByTestId('diagram-row-auth-flow.html')).toContainText('auth-flow')

  // Opening the tab shows the newest without being asked.
  await expect(page.getByTestId('diagram-frame')).toHaveAttribute(
    'srcdoc',
    /billing-webhook\.html/,
  )
  await expect(page.getByTestId('diagrams-view')).toContainText('s-alpha')
})

// Single click reads it into the pane; double click hands it to the real browser.
test('clicking a past diagram shows it, and double-clicking opens it in the browser', async ({
  page,
}) => {
  await page.evaluate(() => {
    for (const [file, at] of [
      ['auth-flow.html', '2026-08-01T00:00:00.000Z'],
      ['billing-webhook.html', '2026-08-10T00:00:00.000Z'],
    ] as const) {
      window.__mock.addDiagram('p-alpha', {
        file,
        path: `docs/diagrams/${file}`,
        description: file,
        sessionId: 's-alpha',
        modifiedAt: at,
        bytes: 4200,
      })
    }
  })
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('tab-diagrams').click()

  // The newest is shown first; clicking the older one swaps the frame.
  await expect(page.getByTestId('diagram-frame')).toHaveAttribute('srcdoc', /billing-webhook/)
  await page.getByTestId('diagram-row-auth-flow.html').click()
  await expect(page.getByTestId('diagram-frame')).toHaveAttribute('srcdoc', /auth-flow/)

  // Nothing has been handed to the browser by merely looking at it.
  expect(await page.evaluate(() => window.__mock.state().diagramOpens)).toEqual([])

  await page.getByTestId('diagram-row-auth-flow.html').dblclick()
  expect(await page.evaluate(() => window.__mock.state().diagramOpens)).toEqual([
    { projectId: 'p-alpha', file: 'auth-flow.html' },
  ])
})

// The frame must never be able to run what a model wrote into the repo.
test('the diagram frame refuses script, by sandbox as well as by CSP', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.addDiagram('p-alpha', {
      file: 'auth-flow.html',
      path: 'docs/diagrams/auth-flow.html',
      description: 'Auth flow',
      sessionId: 's-alpha',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      bytes: 4200,
    })
  })
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('tab-diagrams').click()

  const frame = page.getByTestId('diagram-frame')
  // An empty sandbox attribute is the whole point: adding allow-scripts here
  // would let a generated file execute inside the app.
  await expect(frame).toHaveAttribute('sandbox', '')
})

test('the empty state names where diagrams will be written, rather than showing an empty list', async ({
  page,
}) => {
  await expect(page.getByTestId('diagrams-empty')).toBeVisible()
  await expect(page.getByTestId('diagrams-empty')).toContainText(DIAGRAMS_DIR)
  await expect(page.getByTestId(/^diagram-row-/)).toHaveCount(0)
})

test('Generate sends the prompt to a background session and stays on the tab', async ({ page }) => {
  await page.getByTestId('diagram-input').fill('Auth flow for login')
  await page.getByTestId('diagram-generate').click()

  // The drawing runs in a background session, so the developer is NOT taken to
  // the conversation: the tab they asked from is where the answer arrives.
  await expect(page.getByTestId('tab-diagrams')).toHaveClass(/sel/)
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.some((s) => s.text.includes(`${DIAGRAMS_DIR}/`))).toBe(true)
  expect(sends.some((s) => s.text.includes('Auth flow for login'))).toBe(true)
})

test('Generate does nothing on an empty or whitespace-only description', async ({ page }) => {
  const before = await page.evaluate(() => window.__mock.state().sends.length)

  // The button itself is disabled while the field is empty/whitespace, so the
  // guard that matters is the one behind the Enter key on the input.
  await expect(page.getByTestId('diagram-generate')).toBeDisabled()
  await page.getByTestId('diagram-input').press('Enter')
  await page.getByTestId('diagram-input').fill('   ')
  await expect(page.getByTestId('diagram-generate')).toBeDisabled()
  await page.getByTestId('diagram-input').press('Enter')

  const after = await page.evaluate(() => window.__mock.state().sends.length)
  expect(after).toBe(before)
  // Neither attempt left the Diagrams tab.
  await expect(page.getByTestId('diagrams-view')).toBeVisible()
})

test('opening a diagram calls through to the host with the right file', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.addDiagram('p-alpha', {
      file: 'auth-flow.html',
      path: 'docs/diagrams/auth-flow.html',
      description: 'Auth flow for login',
      sessionId: 's-alpha',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      bytes: 4200,
    }),
  )
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('tab-diagrams').click()

  await page.getByTestId('diagram-open-auth-flow.html').click()

  const opens = await page.evaluate(() => window.__mock.state().diagramOpens)
  expect(opens).toEqual([{ projectId: 'p-alpha', file: 'auth-flow.html' }])
})

test('the install card shows only while the plugin is absent from the session commands', async ({
  page,
}) => {
  // Before any command list has been reported (twoProjectScenario sets none for
  // p-alpha), the view assumes installed rather than flashing a card that a
  // moment later turns out wrong.
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)

  // A real command list, missing the plugin's probe command: the card shows.
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['some-other-command']))
  await expect(page.getByTestId('diagrams-install')).toBeVisible()

  // The probe command shows up (installed): the card goes away.
  await page.evaluate(
    (probeCommand) => window.__mock.setCommands('p-alpha', [probeCommand]),
    DIAGRAM_PLUGIN.probeCommand,
  )
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
})
