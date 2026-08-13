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

// The wait is for ONE file. When it lands, that is the thing to be looking at —
// the pending row said so for however many minutes it took. It used to land in
// the list and leave the pane on whatever was selected before it, or on nothing
// at all, which reads as the diagram having failed.
test('the diagram you asked for is the one showing when it arrives', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.addDiagram('p-alpha', {
      file: 'older.html',
      path: 'docs/diagrams/older.html',
      description: 'An earlier diagram',
      sessionId: 's-alpha',
      modifiedAt: new Date(Date.now() - 60_000).toISOString(),
      bytes: 2048,
    })
  })
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()
  await expect(page.getByTestId('diagram-frame')).toHaveAttribute('srcdoc', /older\.html/)

  await page.getByTestId('diagram-input').fill('Auth flow for login')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const file = await page.evaluate(
    () => window.__mock.state().sends.at(-1)?.text.match(/docs\/diagrams\/([\w.-]+\.html)/)?.[1],
  )
  expect(file).toBeTruthy()

  await page.evaluate((f) => {
    window.__mock.addDiagram('p-alpha', {
      file: f!,
      path: `docs/diagrams/${f}`,
      description: 'Auth flow for login',
      sessionId: 's-alpha',
      modifiedAt: new Date().toISOString(),
      bytes: 8192,
    })
  }, file)

  await expect(page.getByTestId('diagram-pending')).toHaveCount(0)
  await expect(page.getByTestId('diagram-frame')).toHaveAttribute(
    'srcdoc',
    new RegExp(file!.replace(/[.]/g, '[.]')),
  )
})

// Drawing is an ordinary request, not a command — but the plugin ships three
// real commands, and reaching them meant knowing they existed and typing one
// into the conversation.
test('the section offers the plugin commands, and runs one on the diagram in the pane', async ({
  page,
}) => {
  await page.evaluate(
    (probe) => window.__mock.setCommands('p-alpha', [`diagram-design:${probe}`]),
    DIAGRAM_PLUGIN.probeCommand,
  )
  await page.evaluate(() => {
    window.__mock.addDiagram('p-alpha', {
      file: 'auth-flow.html',
      path: 'docs/diagrams/auth-flow.html',
      description: 'Auth flow',
      sessionId: 's-alpha',
      modifiedAt: '2026-08-10T00:00:00.000Z',
      bytes: 4200,
    })
  })
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await expect(page.getByTestId('diagram-command-menu')).toHaveCount(0)
  await page.getByTestId('diagram-commands').click()

  const menu = page.getByTestId('diagram-command-menu')
  await expect(menu).toBeVisible()
  // Every command the plugin ships, described in the plugin's own words.
  await expect(menu.getByTestId(/^diagram-command-/)).toHaveCount(3)
  await expect(page.getByTestId('diagram-command-export-diagram')).toContainText('.svg')
  // Reported by the session, so it is offered; the other two are not, and say so.
  await expect(page.getByTestId('diagram-command-export-diagram')).toBeEnabled()
  await expect(page.getByTestId('diagram-command-import-mermaid')).toBeDisabled()
  await expect(page.getByTestId('diagram-command-import-mermaid')).toContainText(
    'not in this project',
  )

  await page.getByTestId('diagram-command-export-diagram').click()
  await expect(menu).toHaveCount(0)

  // Dispatched with the diagram on screen as its argument — no path typed.
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toBe(`/${DIAGRAM_PLUGIN.namespace}:export-diagram ${DIAGRAMS_DIR}/auth-flow.html`)
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

// The form a session ACTUALLY reports. A plugin's skills arrive namespaced, and
// this test exists because the one above used the bare name and therefore passed
// against an app that was broken for every real user: normalizeForMatch strips
// the colon rather than the namespace, so "diagram-design:export-diagram"
// reduced to "diagramdesignexportdiagram" and never equalled the probe's
// "exportdiagram". Every project with the plugin installed was told it was not,
// and Download re-installed something already present.
test('the card retires for the namespaced skill name a session really reports', async ({ page }) => {
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['some-other-command']))
  await page.getByTestId('tab-diagrams').click()
  await expect(page.getByTestId('diagrams-install')).toBeVisible()

  await page.evaluate(
    (probe) => window.__mock.setCommands('p-alpha', [`diagram-design:${probe}`]),
    DIAGRAM_PLUGIN.probeCommand,
  )
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
})

// A diagram is drawn in a session the developer never opens, so the wait used to
// be a static word for however long it took, with no way to tell work from a
// hang. The events were already streaming to the renderer; nothing rendered
// them. This asserts LIVE output, not the presence of a label — a hard-coded
// "drawing…" would satisfy a weaker test and prove nothing.
test('the pending row shows the drawing session output as it arrives', async ({ page }) => {
  await page.getByTestId('tab-diagrams').click()
  await page.getByTestId('diagram-input').fill('Auth flow for login')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const term = page.getByTestId('mini-terminal')
  await expect(term).toBeVisible()

  // The session the request actually went to, not a guess.
  const sessionId = await page.evaluate(() => window.__mock.state().sends.at(-1)?.sessionId ?? '')
  expect(sessionId).not.toBe('')

  await page.evaluate(
    (id) => window.__mock.emitEvent(id, 'assistant_text', { text: 'writing docs/diagrams' }),
    sessionId,
  )
  await expect(term).toContainText('writing docs/diagrams')

  // And it keeps up, rather than showing only whatever happened to be first.
  await page.evaluate(
    (id) => window.__mock.emitEvent(id, 'assistant_text', { text: 'rendering the SVG' }),
    sessionId,
  )
  await expect(term).toContainText('rendering the SVG')
})

// The probe answers for the wrong environment. Diagrams are drawn in a container
// whose ~/.claude is its own and holds no plugins, so a session's command list
// can say "missing" for a project that has been drawing them all along — and the
// card then sat above a list of finished diagrams offering to install what had
// evidently just worked.
test('a project with diagrams is never offered the download', async ({ page }) => {
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['some-other-command']))
  await expect(page.getByTestId('diagrams-install')).toBeVisible()

  await page.evaluate(() => {
    window.__mock.addDiagram('p-alpha', {
      file: 'auth-flow.html',
      path: `${'docs/diagrams'}/auth-flow.html`,
      description: 'Auth flow for login',
      sessionId: 's-alpha',
      modifiedAt: new Date().toISOString(),
      bytes: 4096,
    })
  })
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await expect(page.getByTestId('diagram-list')).toBeVisible()
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
})

// A plugin is installed on the HOST, by the CLI, in a process no session knows
// about — so nothing told the sessions, and the card that had just installed the
// plugin carried on offering to install it. The only way out was starting a new
// session, which is not an obvious thing to think of when a button looks like it
// did nothing. The real handler now asks every live session to reload its
// plugins, and this asserts the consequence a developer actually sees.
test('installing the plugin retires the install card', async ({ page }) => {
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['some-other-command']))
  await page.getByTestId('tab-diagrams').click()

  const card = page.getByTestId('diagrams-install')
  await expect(card).toBeVisible()
  await card.click()

  // Gone, without a restart and without a project switch.
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
  // And it reached the CLI with the right package, not just hid the card.
  const installs = await page.evaluate(() => window.__mock.state().pluginInstalls)
  expect(installs.at(-1)?.pkg).toBe(DIAGRAM_PLUGIN.pkg)
})
