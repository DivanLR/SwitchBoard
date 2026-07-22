// T040: clean view collapse, in-place expansion, raw completeness, rule
// editing, and the error exemption (quickstart V3).
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
  // The narrative stays visible.
  await expect(page.getByTestId('stream-event-assistant_text')).toContainText('Build finished.')
  // Clean view displays far fewer rows than the raw output (SC-005: >= 60% reduction).
  await expect(page.getByTestId('stream').getByTestId('stream-event-raw_output')).toHaveCount(0)
})

test('empty assistant text renders nothing — no orphan timestamp row', async ({ page }) => {
  await page.evaluate(() => {
    // The SDK can emit an empty text block; it must not render as a bare row
    // (which, with timestamps on, showed a stamp beside blank space).
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

test('clean view shows commands being run by default; raw view shows them too', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'tool_activity', { toolName: 'Bash', inputPreview: 'npm test' })
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: 'Tests pass.', partial: false })
  })
  // Clean view now shows tool activity too (showToolRows defaults on).
  await expect(page.getByTestId('stream').getByTestId('stream-event-tool_activity')).toContainText(
    'npm test',
  )
  await expect(page.getByTestId('stream-event-assistant_text')).toContainText('Tests pass.')
  // Raw view: the command line is present too.
  await page.getByTestId('view-raw').click()
  await expect(page.getByTestId('stream')).toContainText('npm test')
})

test('the raw view shows timestamps when the Timestamps setting is on', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: 'Line one.', partial: false }),
  )
  await page.getByTestId('view-raw').click()
  await expect(page.getByTestId('raw-stamp')).toHaveCount(0)
  // Turn on Timestamps in Settings → Terminals.
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-term').click()
  await page.getByTestId('setting-timestamps').click()
  await page.getByTestId('settings-done').click()
  // Raw lines now carry an HH:MM gutter.
  await expect(page.getByTestId('raw-stamp').first()).toHaveText(/^\d{2}:\d{2}$/)
})

test('errors are never swallowed (FR-017)', async ({ page }) => {
  await emitBuildNoise(page, 10)
  await page.evaluate(() =>
    window.__mock.emitEvent('s-alpha', 'error', { text: 'Compiling failed: syntax error', fatal: false }),
  )
  await emitBuildNoise(page, 10)

  // The error splits the noise into two blocks and stays prominent.
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
  await expect(card).toContainText('⑂ AGENTS')
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

  // The main clean view hides subagent internals.
  const stream = page.getByTestId('stream')
  await expect(stream).toContainText('Main loop narrative.')
  await expect(stream).not.toContainText('Planned 9 cases')

  // AGENTS card rows advertise the chat and open it.
  await expect(page.getByTestId('agent-list')).toContainText('chat →')
  await page.getByTestId('agent-row').first().click()

  await expect(page.getByTestId('agent-banner')).toContainText('← alpha')
  await expect(page.getByTestId('agent-banner')).toContainText('Write rotation tests')
  await expect(page.getByTestId('agent-banner')).toContainText('subagent')
  // Scoped stream: the delegating prompt opens the chat, agent output follows,
  // main-loop text is gone.
  await expect(stream).toContainText('[alpha] Cover reuse-revoke edge cases')
  await expect(stream).toContainText('Planned 9 cases — 6 written so far.')
  await expect(stream).not.toContainText('Main loop narrative.')

  // The sidebar marks the open agent; the composer addresses it.
  await expect(page.getByTestId('sidebar-agent-test-writer')).toContainText('Write rotation tests ←')
  await expect(page.getByTestId('composer-to')).toContainText('to Write rotation tests')
  await page.getByTestId('composer-input').fill('prioritise the replay case')
  await page.getByTestId('composer-send').click()
  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.some((s) => s.text === '[to test-writer] prioritise the replay case')).toBe(true)

  // Back link returns to the session stream.
  await page.getByTestId('agent-back').click()
  await expect(stream).toContainText('Main loop narrative.')
  await expect(stream).not.toContainText('Planned 9 cases')
})
