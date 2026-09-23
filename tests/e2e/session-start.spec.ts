import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()
})

test('the composer greys out when the session has ended', async ({ page }) => {
  const composer = page.getByTestId('composer-dead')
  await expect(composer).toBeVisible()
  await expect(page.getByTestId('composer-live')).toHaveCount(0)

  await expect(page.getByTestId('composer-input')).toBeDisabled()
  await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', 'Start a session first')

  const dead = await composer.evaluate((el) => ({
    row: getComputedStyle(el.querySelector('.composer-row')!).opacity,
    panel: getComputedStyle(el).backgroundColor,
    caret: getComputedStyle(el.querySelector('.composer-input')!).caretColor,
  }))
  expect(Number(dead.row)).toBeLessThan(1)
  expect(dead.caret).toBe('rgba(0, 0, 0, 0)')

  await page.getByTestId('sidebar-project-beta').click()
  const live = page.getByTestId('composer-live')
  await expect(live).toBeVisible()
  const alive = await live.evaluate((el) => ({
    row: getComputedStyle(el.querySelector('.composer-row')!).opacity,
    panel: getComputedStyle(el).backgroundColor,
  }))
  expect(Number(alive.row)).toBe(1)
  expect(alive.panel).not.toBe(dead.panel)
})

test('the mode picker offers every mode the SDK can spawn, each with its description', async ({
  page,
}) => {
  await page.getByTestId('start-mode-picker').click()
  const list = page.getByTestId('start-mode-list')
  await expect(list).toBeVisible()

  for (const mode of ['default', 'dontAsk', 'auto', 'acceptEdits', 'plan', 'bypass']) {
    await expect(list.getByTestId(`start-mode-${mode}`)).toBeVisible()
  }

  const bypass = list.getByTestId('start-mode-bypass')
  await expect(bypass).toContainText('disposable WSL container')
  await expect(bypass).toHaveAttribute('title', /disposable WSL container/)
})

test('choosing bypass states what it means, rather than only colouring the control', async ({
  page,
}) => {
  await expect(page.getByTestId('bypass-warning')).toHaveCount(0)

  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-bypass').click()

  await expect(page.getByTestId('start-mode-list')).toHaveCount(0)
  await expect(page.getByTestId('bypass-warning')).toContainText('Nothing will ask for approval')

  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-plan').click()
  await expect(page.getByTestId('bypass-warning')).toHaveCount(0)
})

test('resuming a native session never offers bypass, because its transcript is on this machine', async ({
  page,
}) => {
  await page.getByTestId('resume-session').click()
  await page.getByTestId('start-mode-picker').click()
  const list = page.getByTestId('start-mode-list')
  await expect(list.getByTestId('start-mode-default')).toBeVisible()
  await expect(list.getByTestId('start-mode-bypass')).toHaveCount(0)
  await expect(list).toContainText('on this machine')
})

test('a session can be asked to run in a container without choosing bypass', async ({ page }) => {
  const toggle = page.getByTestId('run-in-container')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('start-session').click()
  await expect
    .poll(
      async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1)?.containerised,
    )
    .toBe(true)
  const last = (await page.evaluate(() => window.__mock.state().starts)).at(-1)
  expect(last?.bypassPermissions).toBe(false)
})

test('a native start is what happens when the switch is left alone', async ({ page }) => {
  await page.getByTestId('start-session').click()
  await expect
    .poll(
      async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1)?.containerised,
    )
    .toBe(false)
})

test('bypass shows the switch on and locked, because it has never had a choice', async ({
  page,
}) => {
  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-bypass').click()

  const toggle = page.getByTestId('run-in-container')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeDisabled()
  await toggle.click({ force: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('start-session').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1)?.mode)
    .toBe('bypass')
  const last = (await page.evaluate(() => window.__mock.state().starts)).at(-1)
  expect(last?.containerised).toBe(true)
})

test('picking a mode starts the next session in it', async ({ page }) => {
  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-plan').click()
  await expect(page.getByTestId('start-mode-list')).toHaveCount(0)
  await expect(page.getByTestId('start-mode-picker')).toContainText('Plan first')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ projectId: 'p-alpha', mode: 'plan', resume: false })
})

test('Resume asks for a real resume of the previous conversation', async ({ page }) => {
  const resume = page.getByTestId('resume-session')
  await expect(resume).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('start-session')).toContainText('Start session')

  await resume.click()
  await expect(resume).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('start-session')).toContainText('Resume')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ projectId: 'p-alpha', resume: true })
})

test('Resume is refused when there is no conversation to resume', async ({ page }) => {
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  await page.getByTestId('end-session').click()
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  const resume = page.getByTestId('resume-session')
  await expect(resume).toBeDisabled()
  await expect(resume).toHaveAttribute('aria-checked', 'false')
})

test('a start that crashes immediately surfaces its reason as the start error', async ({ page }) => {
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const sessionId = await page.evaluate(async () => {
    const { projects } = await window.switchboard.invoke('projects.list', undefined)
    return projects.find((p) => p.id === 'p-alpha')?.session?.id
  })
  expect(sessionId).toBeTruthy()

  await page.evaluate(
    (id) => window.__mock.crashSession(id as string, 'The Claude Code process exited with code 13.'),
    sessionId,
  )

  await expect(page.getByTestId('start-error')).toContainText('code 13')
  await expect(page.getByTestId('ended-banner')).toBeVisible()
})

test('a failed resume turns Resume back off, and says why in the message', async ({ page }) => {
  await page.getByTestId('resume-session').click()
  await expect(page.getByTestId('resume-session')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const sessionId = await page.evaluate(async () => {
    const { projects } = await window.switchboard.invoke('projects.list', undefined)
    return projects.find((p) => p.id === 'p-alpha')?.session?.id
  })
  await page.evaluate(
    (id) => window.__mock.crashSession(id as string, 'The last conversation could not be resumed.'),
    sessionId,
  )

  await expect(page.getByTestId('start-error')).toContainText('Resume failed, starting fresh')
  await expect(page.getByTestId('start-error')).toContainText('could not be resumed')
  await expect(page.getByTestId('resume-session')).toHaveAttribute('aria-checked', 'false')
})

test('the effort bar starts at xhigh and reveals the subagent bar only at max', async ({ page }) => {
  const bar = page.getByTestId('effort-bar')
  await expect(bar).toBeVisible()
  await expect(page.getByTestId('effort-bar-value')).toHaveText('xhigh')
  await expect(page.getByTestId('subagent-effort-bar')).toHaveCount(0)

  await bar.fill('4')
  await expect(page.getByTestId('effort-bar-value')).toHaveText('max')
  await expect(page.getByTestId('subagent-effort-bar')).toBeVisible()
  await expect(page.getByTestId('subagent-effort-bar-value')).toHaveText('low')

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-models').click()
  await expect(page.getByTestId('setting-effort-value')).toHaveText('max')
  await page.getByTestId('setting-subagent-effort').fill('4')
  await page.getByTestId('settings-done').click()
  await expect(page.getByTestId('subagent-effort-bar-value')).toHaveText('max')

  await bar.fill('0')
  await expect(page.getByTestId('effort-bar-value')).toHaveText('low')
  await expect(page.getByTestId('subagent-effort-bar')).toHaveCount(0)
})

test('at max the effort fill spans the whole track in both themes', async ({ page }) => {
  const bar = page.getByTestId('effort-bar')
  const span = async (testid: string): Promise<{ fill: number; track: number; gap: number }> => {
    const fill = (await page.getByTestId(`${testid}-fill`).boundingBox())!
    const track = (await page.getByTestId(`${testid}-track`).boundingBox())!
    return { fill: fill.width, track: track.width, gap: track.x + track.width - (fill.x + fill.width) }
  }

  await bar.fill('2')
  const partial = await span('effort-bar')
  expect(partial.fill).toBeLessThan(partial.track * 0.75)

  await bar.fill('4')
  await page.getByTestId('subagent-effort-bar').fill('4')
  for (const dark of [false, true]) {
    if (dark) {
      await page.getByTestId('theme-toggle').click()
      await expect(page.locator('html')).not.toHaveClass(/sb-light/)
    }
    for (const testid of ['effort-bar', 'subagent-effort-bar']) {
      const full = await span(testid)
      expect(full.track).toBeGreaterThan(60)
      expect(Math.abs(full.fill - full.track)).toBeLessThan(0.5)
      expect(Math.abs(full.gap)).toBeLessThan(0.5)
    }
  }

  await bar.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('effort-bar-value')).toHaveText('xhigh')
  await page.keyboard.press('End')
  await expect(page.getByTestId('effort-bar-value')).toHaveText('max')

  for (const [end, value] of [
    ['start', 'low'],
    ['end', 'max'],
  ]) {
    const box = (await bar.boundingBox())!
    await page.mouse.click(end === 'start' ? box.x + 1 : box.x + box.width - 1, box.y + box.height / 2)
    await expect(page.getByTestId('effort-bar-value')).toHaveText(value)
  }
})

