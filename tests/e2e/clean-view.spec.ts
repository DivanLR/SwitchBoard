import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

function emitBuildNoise(page: import('@playwright/test').Page, count: number): Promise<void> {
  return page.evaluate((n) => {
    const lines = Array.from({ length: n }, (_, i) => `Compiling module ${i} of ${n}`)
    window.__mock.emitLines('s-alpha', lines)
  }, count)
}

test('heavy build output collapses into a labelled swallowed block (FR-015)', async ({ page }) => {
  await emitBuildNoise(page, 30)
  await page.evaluate(() =>
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: 'Build finished.', partial: false }),
  )

  const block = page.getByTestId('swallowed-block')
  await expect(block).toHaveCount(1)
  await expect(block).toContainText('Worked quietly for a bit · build output')
  await expect(page.getByTestId('stream-event-assistant_text')).toContainText('Build finished.')
  await expect(page.getByTestId('stream').getByTestId('stream-event-raw_output')).toHaveCount(0)
})

test('empty assistant text renders nothing — no orphan timestamp row', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: '', partial: false })
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: 'Real narrative.', partial: false })
  })
  const events = page.getByTestId('stream-event-assistant_text')
  await expect(events).toHaveCount(1)
  await expect(events).toContainText('Real narrative.')
})

test('a swallowed block expands in place (FR-016)', async ({ page }) => {
  await emitBuildNoise(page, 12)
  const block = page.getByTestId('swallowed-block')
  await block.locator('.toggle').click()
  await expect(block).toContainText('Compiling module 3 of 12')
})

test('the raw view retains 100% of the output (FR-018)', async ({ page }) => {
  await emitBuildNoise(page, 25)
  await page.getByTestId('view-raw').click()
  await expect(page.getByTestId('raw-line')).toHaveCount(25)
  await expect(page.getByTestId('swallowed-block')).toHaveCount(0)

  await page.getByTestId('view-clean').click()
  await expect(page.getByTestId('swallowed-block')).toHaveCount(1)
})

test('clean view hides tool rows by default; raw view keeps them', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'tool_activity', { toolName: 'Bash', inputPreview: 'npm test' })
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: 'Tests pass.', partial: false })
  })
  await expect(page.getByTestId('stream').getByTestId('stream-event-tool_activity')).toHaveCount(0)
  await expect(page.getByTestId('stream-event-assistant_text')).toContainText('Tests pass.')
  await page.getByTestId('view-raw').click()
  await expect(page.getByTestId('stream')).toContainText('npm test')
})

test('the raw view shows timestamps when the Timestamps setting is on', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: 'Line one.', partial: false }),
  )
  await page.getByTestId('view-raw').click()
  await expect(page.getByTestId('raw-stamp')).toHaveCount(0)
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-term').click()
  await page.getByTestId('setting-timestamps').click()
  await page.getByTestId('settings-done').click()
  await expect(page.getByTestId('raw-stamp').first()).toHaveText(/^\d{2}:\d{2}$/)
})

test('errors are never swallowed (FR-017)', async ({ page }) => {
  await emitBuildNoise(page, 10)
  await page.evaluate(() =>
    window.__mock.emitEvent('s-alpha', 'error', { text: 'Compiling failed: syntax error', fatal: false }),
  )
  await emitBuildNoise(page, 10)

  await expect(page.getByTestId('error-event')).toBeVisible()
  await expect(page.getByTestId('swallowed-block')).toHaveCount(2)
})

test('parallel subagents are listed: stream card, header pill, and sidebar rows', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'tool_activity', {
      toolName: 'Task',
      inputPreview: '{"description":"Write rotation tests","subagent_type":"test-writer"}',
    })
    window.__mock.emitEvent('s-alpha', 'tool_activity', {
      toolName: 'Task',
      inputPreview: '{"description":"Implement family revoke","subagent_type":"reuse-guard"}',
    })
  })
  const card = page.getByTestId('agent-list')
  await expect(card).toContainText('AGENTS')
  await expect(card).toContainText('2 working in parallel')
  await expect(page.getByTestId('agent-row')).toHaveCount(2)
  await expect(card).toContainText('test-writer')
  await expect(card).toContainText('Implement family revoke')
  await expect(page.getByTestId('agents-pill')).toContainText('2 agents')
  await expect(page.getByTestId('sidebar-agents-alpha')).toContainText('Implement family revoke')
})

test('clicking an agent opens its chat: banner, scoped stream, addressed composer', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'tool_activity', {
      toolName: 'Task',
      toolUseId: 'tu-1',
      inputPreview: '{"description":"Write rotation tests","prompt":"Cover reuse-revoke edge cases","subagent_type":"test-writer"}',
    })
    window.__mock.emitEvent('s-alpha', 'tool_activity', {
      toolName: 'Task',
      toolUseId: 'tu-2',
      inputPreview: '{"description":"Implement family revoke","subagent_type":"reuse-guard"}',
    })
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: 'Planned 9 cases — 6 written so far.',
      partial: false,
      agentId: 'tu-1',
    })
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: 'Main loop narrative.',
      partial: false,
    })
  })

  const stream = page.getByTestId('stream')
  await expect(stream).toContainText('Main loop narrative.')
  await expect(stream).not.toContainText('Planned 9 cases')

  await expect(page.getByTestId('agent-list')).toContainText('chat')
  await page.getByTestId('agent-row').first().click()

  await expect(page.getByTestId('agent-banner')).toContainText('alpha')
  await expect(page.getByTestId('agent-banner')).toContainText('Write rotation tests')
  await expect(page.getByTestId('agent-banner')).toContainText('subagent')
  await expect(stream).toContainText('[alpha] Cover reuse-revoke edge cases')
  await expect(stream).toContainText('Planned 9 cases — 6 written so far.')
  await expect(stream).not.toContainText('Main loop narrative.')

  await expect(page.getByTestId('sidebar-agent-test-writer')).toContainText('Write rotation tests')
  await expect(
    page.getByTestId('sidebar-agent-test-writer').getByTestId('sidebar-agent-selected'),
  ).toBeVisible()
  await expect(page.getByTestId('composer-to')).toContainText('to Write rotation tests')
  await page.getByTestId('composer-input').fill('prioritise the replay case')
  await page.getByTestId('composer-send').click()
  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.some((s) => s.text === '[to test-writer] prioritise the replay case')).toBe(true)

  await page.getByTestId('agent-back').click()
  await expect(stream).toContainText('Main loop narrative.')
  await expect(stream).not.toContainText('Planned 9 cases')
})

test('clean view shows only the action + status for a command, never the full command', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      toolName: 'Bash',
      title: 'Run a command: rm -rf node_modules && npm ci',
      risk: 'medium',
    }),
  )
  const marker = page.getByTestId('permission-marker')
  await expect(marker).toBeVisible()
  await expect(marker).toContainText('Ran a command')
  await expect(marker).toContainText('Needs approval')
  await expect(marker).not.toContainText('rm -rf')
  await expect(marker).not.toContainText('npm ci')
})

test('clean view tool rows are command-free — description only, no command or output', async ({
  page,
}) => {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-term').click()
  await page.getByTestId('setting-tool-rows').click()
  await page.getByTestId('settings-done').click()

  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'tool_activity', {
      toolName: 'Bash',
      inputPreview: JSON.stringify({
        command: 'rm -rf dist && npm ci',
        description: 'Reinstall dependencies',
      }),
      resultPreview: 'added 400 packages in 12s',
    })
  })
  const row = page.getByTestId('stream').getByTestId('stream-event-tool_activity')
  await expect(row).toContainText('Reinstall dependencies')
  await expect(row).not.toContainText('rm -rf')
  await expect(row).not.toContainText('added 400 packages')

  await page.getByTestId('view-raw').click()
  await expect(page.getByTestId('stream')).toContainText('rm -rf dist')
})

test('history paged in with "show earlier" survives new output', async ({ page }) => {
  await page.evaluate(() => {
    for (let i = 0; i < 620; i++) {
      window.__mock.emitEvent('s-alpha', 'assistant_text', { text: `line ${i}`, partial: false })
    }
  })
  const first = page.getByTestId('stream').getByText('line 0', { exact: true })
  await expect(first).toHaveCount(0)

  await page.getByTestId('show-earlier').click()
  await expect(first).toBeVisible()

  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) {
      window.__mock.emitEvent('s-alpha', 'assistant_text', { text: `after ${i}`, partial: false })
    }
  })
  await expect(page.getByTestId('stream').getByText('after 39', { exact: true })).toBeVisible()
  await expect(first).toBeVisible()
})
