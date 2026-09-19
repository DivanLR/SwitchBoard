import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

declare global {
  interface Window {
    __terminal: {
      calls: { method: string; req: Record<string, unknown> }[]
      failOpen: boolean
      push: (channel: string, payload: unknown) => void
      listenerCount: () => number
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.addInitScript(() => {
    const original = window.switchboard
    let clipboardText = ''
    const listeners = new Map<string, Set<(payload: unknown) => void>>()
    const fixture: Window['__terminal'] = {
      calls: [],
      failOpen: false,
      push: (channel, payload) => {
        for (const listener of listeners.get(channel) ?? []) listener(payload)
      },
      listenerCount: () => listeners.get('push.terminalData')?.size ?? 0,
    }
    window.__terminal = fixture
    window.switchboard = {
      ...original,
      on: (channel: string, listener: (payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set()
        set.add(listener)
        listeners.set(channel, set)
        const stop = original.on(channel as Parameters<typeof original.on>[0], listener)
        return () => {
          set.delete(listener)
          stop()
        }
      },
      invoke: async (method: string, req: Record<string, unknown>) => {
        if (method === 'clipboard.write') {
          clipboardText = String(req.text)
          return
        }
        if (method === 'clipboard.read') return { text: clipboardText }
        if (method.startsWith('terminal.')) fixture.calls.push({ method, req })
        if (method === 'terminal.open') {
          if (fixture.failOpen) throw new Error('Shell could not start')
          fixture.push('push.terminalData', { id: req.id, data: 'early output\r\n' })
          return { scrollback: 'restored history\r\n', reused: true }
        }
        return original.invoke(method as Parameters<typeof original.invoke>[0], req as never)
      },
    } as typeof original
  })
  await page.goto('/')
  await page.getByTestId('sidebar-project-alpha').click()
})

test('Terminal sits beside Clean and Raw, preserves drafts and keeps output alive across views', async ({
  page,
}) => {
  const toggle = page.getByTestId('view-toggle')
  await expect(toggle.getByRole('tab')).toHaveText(['Clean', 'Raw', 'Terminal'])
  await page.getByTestId('composer-input').fill('Keep my draft')
  await toggle.getByRole('tab', { name: 'Terminal' }).click()
  const pane = page.getByTestId('terminal-pane')
  await expect(pane).toBeVisible()
  await expect(page.getByTestId('stream')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveCount(0)
  await expect(pane.locator('.xterm-rows')).toContainText('restored history')
  await expect(pane.locator('.xterm-rows')).toContainText('early output')
  await page.getByTestId('view-raw').click()
  await expect(pane).toBeHidden()
  await expect(page.getByTestId('stream')).toBeVisible()
  await expect(page.getByTestId('composer-input')).toHaveValue('Keep my draft')
  await page.evaluate(() =>
    window.__terminal.push('push.terminalData', { id: 's-alpha', data: 'background output\r\n' }),
  )
  await page.getByTestId('tab-terminal').click()
  await expect(pane.locator('.xterm-rows')).toContainText('background output')
  expect(
    await page.evaluate(
      () => window.__terminal.calls.filter((c) => c.method === 'terminal.open').length,
    ),
  ).toBe(1)
  await page.getByTestId('view-clean').click()
  await expect(page.getByTestId('composer-input')).toHaveValue('Keep my draft')
})

test('keyboard input, paste, resize and full screen use the terminal bridge', async ({ page }) => {
  await page.getByTestId('tab-terminal').click()
  const pane = page.getByTestId('terminal-pane')
  const input = pane.locator('.xterm-helper-textarea')
  await expect(input).toBeFocused()
  await input.pressSequentially('echo hello')
  await input.press('Enter')
  await input.press('Control+c')
  await page.evaluate(() =>
    window.switchboard.invoke('clipboard.write', { text: 'pasted command' }),
  )
  await pane.getByRole('button', { name: 'Paste', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__terminal.calls
          .filter((c) => c.method === 'terminal.write')
          .map((c) => c.req.data)
          .join(''),
      ),
    )
    .toContain('echo hello\r\u0003pasted command')
  expect(await page.evaluate(() => window.__mock.state().interrupts)).toEqual([])
  await page.getByTestId('terminal-full-screen').click()
  await expect(page.getByTestId('view-toggle')).toHaveCount(0)
  await expect(pane).toHaveClass(/full/)
  await input.press('Escape')
  await expect(page.getByTestId('view-toggle')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__terminal.calls.filter((c) => c.method === 'terminal.resize').at(-1)?.req.cols,
      ),
    )
    .toBeGreaterThan(50)
})

for (const shortcut of ['Control+v', 'Control+Shift+v', 'Shift+Insert']) {
  test(`${shortcut} pastes clipboard text exactly once into the terminal`, async ({ page }) => {
    await page.getByTestId('tab-terminal').click()
    const input = page.getByTestId('terminal-pane').locator('.xterm-helper-textarea')
    await expect(input).toBeFocused()
    await page.evaluate(() =>
      window.switchboard.invoke('clipboard.write', { text: 'clipboard command' }),
    )
    await input.press(shortcut)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__terminal.calls
            .filter((c) => c.method === 'terminal.write')
            .map((c) => c.req.data)
            .join(''),
        ),
      )
      .toBe('clipboard command')
    await expect(input).toHaveValue('')
    expect(await page.evaluate(() => window.__mock.state().interrupts)).toEqual([])
  })
}

test('exit and repeated restart deliver output once', async ({ page }) => {
  await page.getByTestId('tab-terminal').click()
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() =>
      window.__terminal.push('push.terminalExit', { id: 's-alpha', exitCode: 1 }),
    )
    await expect(page.getByTestId('terminal-exited')).toContainText('Shell exited (1)')
    await page.getByTestId('terminal-restart').click()
    await expect(page.getByTestId('terminal-exited')).toHaveCount(0)
  }
  await page.evaluate(() =>
    window.__terminal.push('push.terminalData', {
      id: 's-alpha',
      data: 'unique output marker\r\n',
    }),
  )
  const rows = page.getByTestId('terminal-pane').locator('.xterm-rows')
  await expect(rows).toContainText('unique output marker')
  expect((await rows.innerText()).match(/unique output marker/g)).toHaveLength(1)
})

test('startup failures are recoverable and projects do not open hidden terminals', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__terminal.failOpen = true
  })
  await page.getByTestId('tab-terminal').click()
  await expect(page.getByTestId('terminal-error')).toContainText('Shell could not start')
  await page.evaluate(() => {
    window.__terminal.failOpen = false
  })
  await page.getByTestId('terminal-error').getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('terminal-error')).toHaveCount(0)
  await page.getByTestId('sidebar-project-beta').click()
  await expect(page.getByTestId('stream')).toBeVisible()
  expect(
    await page.evaluate(() =>
      window.__terminal.calls.filter((c) => c.method === 'terminal.open' && c.req.id === 's-beta'),
    ),
  ).toHaveLength(0)
  await page.getByTestId('tab-terminal').click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__terminal.calls.filter(
            (c) => c.method === 'terminal.open' && c.req.id === 's-beta',
          ).length,
      ),
    )
    .toBe(1)
  await page.evaluate(() =>
    window.__terminal.push('push.terminalData', {
      id: 's-alpha',
      data: 'wrong project output\r\n',
    }),
  )
  await expect(page.getByTestId('terminal-pane')).not.toContainText('wrong project output')
})

test('the terminal is keyed by the session and follows + Session', async ({ page }) => {
  await page.getByTestId('tab-terminal').click()
  const pane = page.getByTestId('terminal-pane')
  await expect(pane.getByTestId('terminal-title')).toHaveText('Shell')
  await expect(pane.getByTestId('terminal-live-note')).toBeVisible()
  const opens = () =>
    page.evaluate(() =>
      window.__terminal.calls
        .filter((c) => c.method === 'terminal.open')
        .map((c) => ({ id: c.req.id, engine: c.req.engine, resume: c.req.resumeSessionId ?? null })),
    )
  expect(await opens()).toEqual([{ id: 's-alpha', engine: 'shell', resume: null }])
  await page.getByTestId('new-session').click()
  await expect.poll(opens).toHaveLength(2)
  const [, second] = await opens()
  expect(second.id).not.toBe('s-alpha')
  expect(second.engine).toBe('shell')
  await expect(pane).toBeVisible()
  await expect(page.getByTestId('stream')).toHaveCount(0)
})

test('Continue it here ends the SDK session and resumes the same conversation in the CLI', async ({
  page,
}) => {
  await page.getByTestId('tab-terminal').click()
  const pane = page.getByTestId('terminal-pane')
  await pane.getByTestId('terminal-takeover').click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__terminal.calls
            .filter((c) => c.method === 'terminal.open')
            .at(-1)?.req,
      ),
    )
    .toMatchObject({ id: 's-alpha', engine: 'claude', resumeSessionId: 'sdk-s-alpha' })
  await expect(pane.getByTestId('terminal-title')).toHaveText('Claude Code')
  await expect(pane.getByTestId('terminal-takeover')).toHaveCount(0)
  await page.getByTestId('view-clean').click()
  await expect(page.getByTestId('ended-banner')).toBeVisible()
})

test('view tabs support arrow keys and retain the selected session view', async ({ page }) => {
  await page.getByTestId('view-clean').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('view-raw')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('terminal-pane')).toBeVisible()
  await page.getByTestId('tab-terminal').focus()
  await page.keyboard.press('Home')
  await expect(page.getByTestId('view-clean')).toBeFocused()
  await expect(page.getByTestId('terminal-pane')).toBeHidden()
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('tab-session').click()
  await expect(page.getByTestId('view-clean')).toHaveAttribute('aria-selected', 'true')
})

test('terminal fits the workspace in light and dark themes at the minimum window size', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 620 })
  await page.getByTestId('tab-terminal').click()
  const pane = page.getByTestId('terminal-pane')
  for (const theme of ['light', 'dark']) {
    const toggle = page.getByTestId('theme-toggle')
    if ((await toggle.getAttribute('title'))?.includes(`Switch to ${theme}`)) await toggle.click()
    await expect(pane.locator('.xterm-rows')).toContainText('restored history')
    const panelBox = await pane.boundingBox()
    const terminalBox = await pane.locator('.xterm-screen').boundingBox()
    expect(panelBox).not.toBeNull()
    expect(terminalBox).not.toBeNull()
    expect(terminalBox!.height).toBeGreaterThan(80)
    expect(terminalBox!.x + terminalBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(620)
    await page.screenshot({
      path: testInfo.outputPath(`terminal-${theme}.png`),
      animations: 'disabled',
    })
  }
})
