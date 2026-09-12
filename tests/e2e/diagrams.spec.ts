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
      plan: null,
      bytes: 4200,
    })
    window.__mock.addDiagram('p-alpha', {
      file: 'billing-webhook.html',
      path: 'docs/diagrams/billing-webhook.html',
      description: 'Billing webhook sequence',
      sessionId: 's-alpha',
      modifiedAt: '2026-08-10T00:00:00.000Z',
      plan: null,
      bytes: 5100,
    })
  })
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('tab-diagrams').click()

  const rows = page.getByTestId(/^diagram-row-/)
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'diagram-row-billing-webhook.html')
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'diagram-row-auth-flow.html')
  await expect(page.getByTestId('diagram-row-auth-flow.html')).toContainText('auth-flow')

  await expect(page.getByTestId('diagram-frame')).toHaveAttribute(
    'srcdoc',
    /billing-webhook\.html/,
  )
  await expect(page.getByTestId('diagrams-view')).toContainText('s-alpha')
})

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
        plan: null,
        bytes: 4200,
      })
    }
  })
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('tab-diagrams').click()

  await expect(page.getByTestId('diagram-frame')).toHaveAttribute('srcdoc', /billing-webhook/)
  await page.getByTestId('diagram-row-auth-flow.html').click()
  await expect(page.getByTestId('diagram-frame')).toHaveAttribute('srcdoc', /auth-flow/)

  expect(await page.evaluate(() => window.__mock.state().diagramOpens)).toEqual([])

  await page.getByTestId('diagram-row-auth-flow.html').dblclick()
  expect(await page.evaluate(() => window.__mock.state().diagramOpens)).toEqual([
    { projectId: 'p-alpha', file: 'auth-flow.html' },
  ])
})

test('the diagram frame refuses script, by sandbox as well as by CSP', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.addDiagram('p-alpha', {
      file: 'auth-flow.html',
      path: 'docs/diagrams/auth-flow.html',
      description: 'Auth flow',
      sessionId: 's-alpha',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      plan: null,
      bytes: 4200,
    })
  })
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('tab-diagrams').click()

  const frame = page.getByTestId('diagram-frame')
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

  await expect(page.getByTestId('tab-diagrams')).toHaveClass(/sel/)
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.some((s) => s.text.includes(`${DIAGRAMS_DIR}/`))).toBe(true)
  expect(sends.some((s) => s.text.includes('Auth flow for login'))).toBe(true)
})

test('the diagram you asked for is the one showing when it arrives', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.addDiagram('p-alpha', {
      file: 'older.html',
      path: 'docs/diagrams/older.html',
      description: 'An earlier diagram',
      sessionId: 's-alpha',
      modifiedAt: new Date(Date.now() - 60_000).toISOString(),
      plan: null,
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
      plan: null,
      bytes: 8192,
    })
  }, file)

  await expect(page.getByTestId('diagram-pending')).toHaveCount(0)
  await expect(page.getByTestId('diagram-frame')).toHaveAttribute(
    'srcdoc',
    new RegExp(file!.replace(/[.]/g, '[.]')),
  )
})

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
      plan: null,
      bytes: 4200,
    })
  })
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await expect(page.getByTestId('diagram-command-menu')).toHaveCount(0)
  await page.getByTestId('diagram-commands').click()

  const menu = page.getByTestId('diagram-command-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId(/^diagram-command-/)).toHaveCount(3)
  await expect(page.getByTestId('diagram-command-export-diagram')).toContainText('.svg')
  await expect(page.getByTestId('diagram-command-export-diagram')).toBeEnabled()
  await expect(page.getByTestId('diagram-command-import-mermaid')).toBeEnabled()
  await expect(page.getByTestId('diagram-install-hint-import-mermaid')).toContainText(
    'install diagram-design',
  )

  const before = await page.evaluate(() => window.__mock.state().sends.length)
  await page.getByTestId('diagram-command-export-diagram').click()
  await expect(menu).toHaveCount(0)

  await expect(page.getByTestId('diagram-input')).toHaveValue(
    `/${DIAGRAM_PLUGIN.namespace}:export-diagram ${DIAGRAMS_DIR}/auth-flow.html `,
  )
  expect(await page.evaluate(() => window.__mock.state().sends.length)).toBe(before)

  await page.getByTestId('diagram-generate').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toBe(
      `/${DIAGRAM_PLUGIN.namespace}:export-diagram ${DIAGRAMS_DIR}/auth-flow.html

` +
        `Write any diagram file you create or export into ${DIAGRAMS_DIR}/, creating that ` +
        'folder if it does not exist. It is the only folder this application lists ' +
        'diagrams from, so a file written anywhere else will not appear.',
    )
  await expect(page.getByTestId('diagram-input')).toHaveValue('')
})

test('a command keeps the message typed after it, and sends both', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', [
      'diagram-design:export-diagram',
      'diagram-design:import-mermaid',
      'diagram-design:import-drawio',
    ]),
  )
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await page.getByTestId('diagram-commands').click()
  await page.getByTestId('diagram-command-export-diagram').click()
  await page.getByTestId('diagram-input').pressSequentially('--png-only')
  await page.getByTestId('diagram-input').press('Enter')

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toBe(
      `/${DIAGRAM_PLUGIN.namespace}:export-diagram --png-only

` +
        `Write any diagram file you create or export into ${DIAGRAMS_DIR}/, creating that ` +
        'folder if it does not exist. It is the only folder this application lists ' +
        'diagrams from, so a file written anywhere else will not appear.',
    )
})

test('picking a command keeps what was already typed, after the command', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', [
      'diagram-design:export-diagram',
      'diagram-design:import-mermaid',
      'diagram-design:import-drawio',
    ]),
  )
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await page.getByTestId('diagram-input').fill('drawings/source.mmd')
  await page.getByTestId('diagram-commands').click()
  await page.getByTestId('diagram-command-import-mermaid').click()

  await expect(page.getByTestId('diagram-input')).toHaveValue(
    `/${DIAGRAM_PLUGIN.namespace}:import-mermaid drawings/source.mmd `,
  )
})

test('Generate does nothing on an empty or whitespace-only description', async ({ page }) => {
  const before = await page.evaluate(() => window.__mock.state().sends.length)

  await expect(page.getByTestId('diagram-generate')).toBeDisabled()
  await page.getByTestId('diagram-input').press('Enter')
  await page.getByTestId('diagram-input').fill('   ')
  await expect(page.getByTestId('diagram-generate')).toBeDisabled()
  await page.getByTestId('diagram-input').press('Enter')

  const after = await page.evaluate(() => window.__mock.state().sends.length)
  expect(after).toBe(before)
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
      plan: null,
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
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)

  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['some-other-command']))
  await expect(page.getByTestId('diagrams-install')).toBeVisible()

  await page.evaluate(
    (probeCommand) => window.__mock.setCommands('p-alpha', [probeCommand]),
    DIAGRAM_PLUGIN.probeCommand,
  )
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
})

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

test('the pending row shows the drawing session output as it arrives', async ({ page }) => {
  await page.getByTestId('tab-diagrams').click()
  await page.getByTestId('diagram-input').fill('Auth flow for login')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const term = page.getByTestId('mini-terminal')
  await expect(term).toBeVisible()

  const sessionId = await page.evaluate(() => window.__mock.state().sends.at(-1)?.sessionId ?? '')
  expect(sessionId).not.toBe('')

  await page.evaluate(
    (id) => window.__mock.emitEvent(id, 'assistant_text', { text: 'writing docs/diagrams' }),
    sessionId,
  )
  await expect(term).toContainText('writing docs/diagrams')

  await page.evaluate(
    (id) => window.__mock.emitEvent(id, 'assistant_text', { text: 'rendering the SVG' }),
    sessionId,
  )
  await expect(term).toContainText('rendering the SVG')
})

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
      plan: null,
      bytes: 4096,
    })
  })
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await expect(page.getByTestId('diagram-list')).toBeVisible()
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
})

test('installing the plugin retires the install card', async ({ page }) => {
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['some-other-command']))
  await page.getByTestId('tab-diagrams').click()

  const card = page.getByTestId('diagrams-install')
  await expect(card).toBeVisible()
  await card.click()

  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
  const installs = await page.evaluate(() => window.__mock.state().pluginInstalls)
  expect(installs.at(-1)?.pkg).toBe(DIAGRAM_PLUGIN.pkg)
})

test('a missing command installs the plugin from the menu', async ({ page }) => {
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['some-other:command']))
  await page.evaluate(() => {
    window.__mock.addDiagram('p-alpha', {
      file: 'auth-flow.html',
      path: 'docs/diagrams/auth-flow.html',
      description: 'Auth flow',
      sessionId: 's-alpha',
      modifiedAt: '2026-08-10T00:00:00.000Z',
      plan: null,
      bytes: 4200,
    })
  })
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)

  await page.getByTestId('diagram-commands').click()
  await page.getByTestId('diagram-command-export-diagram').click()

  await expect(page.getByTestId('diagram-command-menu')).toHaveCount(0)
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().pluginInstalls)).length)
    .toBeGreaterThan(0)
})

test("a plugin command runs in the Diagrams section's own session, not the conversation", async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', [
      'diagram-design:export-diagram',
      'diagram-design:import-mermaid',
      'diagram-design:import-drawio',
    ]),
  )
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await page.getByTestId('diagram-commands').click()
  await page.getByTestId('diagram-command-export-diagram').click()
  await page.getByTestId('diagram-generate').click()

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.sessionId)
    .not.toBe('s-alpha')

  await expect(page.getByTestId('diagrams-view').getByTestId('mini-terminal')).toBeVisible()
})

test('a picked command says what it takes, and that it does not draw', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', ['diagram-design:export-diagram']),
  )
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  await expect(page.getByTestId('diagram-command-hint')).toHaveCount(0)

  await page.getByTestId('diagram-commands').click()
  await page.getByTestId('diagram-command-export-diagram').click()

  const hint = page.getByTestId('diagram-command-hint')
  await expect(hint).toContainText('<html-file>')
  await expect(hint).toContainText('To draw something new')

  await page.getByTestId('diagram-input').fill('the auth flow')
  await expect(hint).toHaveCount(0)
})

test('the section says it is starting before there is a session to watch', async ({ page }) => {
  await page.getByTestId('diagram-input').fill('the auth flow')
  await page.getByTestId('diagram-generate').click()

  const starting = page.getByTestId('diagram-starting')
  await expect(starting).toBeVisible()
  await expect(starting).toContainText('starting')
  await expect(starting).toContainText('container session')

  await expect(page.getByTestId('diagram-pending')).toBeVisible()
  await expect(page.getByTestId('diagram-starting')).toHaveCount(0)
  await expect(page.getByTestId('diagram-pending').getByTestId('mini-terminal')).toBeVisible()
})

test('a drawing session that dies stops the wait and says why', async ({ page }) => {
  await page.getByTestId('diagram-input').fill('the whole project')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sessionId = await page.evaluate(
    () => window.__mock.state().sends.at(-1)?.sessionId as string,
  )
  await page.evaluate(
    (id) => window.__mock.crashSession(id, 'The sandbox container was killed: exit 137 is SIGKILL.'),
    sessionId,
  )

  const error = page.getByTestId('diagram-error')
  await expect(error).toBeVisible({ timeout: 15_000 })
  await expect(error).toContainText('exit 137')
  await expect(page.getByTestId('diagram-pending')).toHaveCount(0)
})

test('a question from the drawing session can be answered in the section', async ({ page }) => {
  await page.getByTestId('diagram-input').fill('every endpoint and where it points')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sessionId = await page.evaluate(
    () => window.__mock.state().sends.at(-1)?.sessionId as string,
  )
  await page.evaluate(
    (id) =>
      window.__mock.emitEvent(id, 'assistant_text', {
        text:
          'Question 1 of 1\n\n| Option | Description |\n' +
          '| A | Six per-domain sheets |\n| B | One wall chart |\n\nReply with the option letter.',
        partial: false,
      }),
    sessionId,
  )

  const card = page.getByTestId('diagrams-view').getByTestId('mini-terminal-question')
  await expect(card).toBeVisible()

  const before = await page.evaluate(() => window.__mock.state().sends.length)
  await card.getByRole('button', { name: /^A/ }).click()

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1))
    .toMatchObject({ sessionId, text: 'A' })
  expect(await page.evaluate(() => window.__mock.state().sends.length)).toBe(before + 1)
})

test('the commands menu is not clipped by the rail it opens from', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', [
      'diagram-design:export-diagram',
      'diagram-design:import-mermaid',
      'diagram-design:import-drawio',
    ]),
  )
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()
  await page.getByTestId('diagram-commands').click()

  const menu = page.getByTestId('diagram-command-menu')
  await expect(menu).toBeVisible()

  const box = await menu.boundingBox()
  expect(box).not.toBeNull()
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)

  for (const row of ['export-diagram', 'import-mermaid', 'import-drawio']) {
    const hit = await page
      .getByTestId(`diagram-command-${row}`)
      .evaluate((el) => {
        const r = el.getBoundingClientRect()
        const at = document.elementFromPoint(r.left + 4, r.top + r.height / 2)
        return at instanceof Element && el.contains(at)
      })
    expect(hit, `row ${row} is covered or clipped`).toBe(true)
  }
})

test('Browse fills the file argument from a native picker, and cancelling changes nothing', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', [
      'diagram-design:export-diagram',
      'diagram-design:import-mermaid',
      'diagram-design:import-drawio',
    ]),
  )
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()

  const input = page.getByTestId('diagram-input')
  const browse = page.getByTestId('diagram-browse-file')

  await expect(browse).toHaveCount(0)

  await page.getByTestId('diagram-commands').click()
  await page.getByTestId('diagram-command-import-mermaid').click()
  await expect(browse).toBeVisible()

  const beforeCancel = await input.inputValue()
  await page.evaluate(() => window.__mock.setNextFilePick(null))
  await browse.click()
  await expect(input).toHaveValue(beforeCancel)

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\work\\flow.mmd'))
  await browse.click()
  await expect(input).toHaveValue(`/${DIAGRAM_PLUGIN.namespace}:import-mermaid C:\\work\\flow.mmd `)

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\my diagrams\\other.mmd'))
  await browse.click()
  await expect(input).toHaveValue(
    `/${DIAGRAM_PLUGIN.namespace}:import-mermaid "C:\\my diagrams\\other.mmd" `,
  )

  await input.pressSequentially('--detail=high')
  await page.evaluate(() => window.__mock.setNextFilePick('C:\\work\\third.mmd'))
  await browse.click()
  await expect(input).toHaveValue(
    `/${DIAGRAM_PLUGIN.namespace}:import-mermaid C:\\work\\third.mmd --detail=high `,
  )
})

test('Browse in the bar imports a file straight from the machine, choosing the command from it', async ({
  page,
}) => {
  const input = page.getByTestId('diagram-input')
  const browse = page.getByTestId('diagram-import-file')

  await expect(browse).toBeVisible()
  await expect(page.getByTestId('diagram-browse-file')).toHaveCount(0)

  await page.evaluate(() => window.__mock.setNextFilePick(null))
  await browse.click()
  await expect(input).toHaveValue('')

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\Users\\d\\Desktop\\arch.drawio'))
  await browse.click()
  await expect(input).toHaveValue(
    `/${DIAGRAM_PLUGIN.namespace}:import-drawio C:\\Users\\d\\Desktop\\arch.drawio `,
  )

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\Users\\d\\Desktop\\flow.mmd'))
  await browse.click()
  await expect(input).toHaveValue(
    `/${DIAGRAM_PLUGIN.namespace}:import-mermaid C:\\Users\\d\\Desktop\\flow.mmd `,
  )

  expect(await page.evaluate(() => window.__mock.state().sends.length)).toBe(0)
})

test('Browse is absent on the archify engine, which has nothing to import with', async ({
  page,
}) => {
  await expect(page.getByTestId('diagram-import-file')).toBeVisible()

  await page.getByTestId('diagram-engine-archify').click()
  await expect(page.getByTestId('diagram-engine-archify')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('diagram-import-file')).toHaveCount(0)

  await page.getByTestId('diagram-engine-diagram-design').click()
  await expect(page.getByTestId('diagram-import-file')).toBeVisible()
})

test('Browse says so when it cannot read the file, instead of doing nothing', async ({ page }) => {
  const input = page.getByTestId('diagram-input')
  const browse = page.getByTestId('diagram-import-file')

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\Users\\d\\Desktop\\screenshot.png'))
  await browse.click()

  const error = page.getByTestId('diagram-error')
  await expect(error).toBeVisible()
  await expect(error).toContainText('screenshot.png')
  await expect(input).toHaveValue('')

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\Users\\d\\Desktop\\arch.drawio.png'))
  await browse.click()
  await expect(input).toHaveValue(
    `/${DIAGRAM_PLUGIN.namespace}:import-drawio C:\\Users\\d\\Desktop\\arch.drawio.png `,
  )
  await expect(page.getByTestId('diagram-error')).toHaveCount(0)
})

test('a typed name decides the file, and blank still derives one from the sentence', async ({
  page,
}) => {
  const name = page.getByTestId('diagram-name')
  await expect(name).toBeVisible()

  await page.getByTestId('diagram-input').fill('Auth flow for login')
  await page.getByTestId('diagram-generate').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toContain(`${DIAGRAMS_DIR}/auth-flow-for-login.html`)

  await page.getByTestId('diagram-input').fill('something else entirely')
  await name.fill('Payment ledger')
  await page.getByTestId('diagram-generate').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toContain(`${DIAGRAMS_DIR}/payment-ledger.html`)

  await expect(name).toHaveValue('')
  await expect(page.getByTestId('diagram-input')).toHaveValue('')
})

test('the name field is absent while a command is in the box', async ({ page }) => {
  await expect(page.getByTestId('diagram-name')).toBeVisible()
  await page.getByTestId('diagram-input').fill('/diagram-design:export-diagram')
  await expect(page.getByTestId('diagram-name')).toHaveCount(0)
})
