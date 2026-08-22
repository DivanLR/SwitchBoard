// Starting a session from the ended banner: one mode picker carrying every mode
// the SDK has, one Resume switch, one Start button — and the heavy-subagent
// setting that shapes how whatever starts does the work.
//
// This replaces the transcript suite. Saving a transcript by hand and carrying
// its digest into the next session were both retired: the main process writes
// every transcript continuously without being asked, and "carry the last one"
// was a weaker approximation of the resume this banner now offers directly.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()
})

// The composer on an ended session. It used to look identical to a live one:
// `.composer-input` sets its own `color`, which beats the browser's disabled
// dimming, so the only cues were a changed placeholder and a greyed Send button.
test('the composer greys out when the session has ended', async ({ page }) => {
  const composer = page.getByTestId('composer-dead')
  await expect(composer).toBeVisible()
  await expect(page.getByTestId('composer-live')).toHaveCount(0)

  // Nothing can be typed, which is what the grey is reporting.
  await expect(page.getByTestId('composer-input')).toBeDisabled()
  await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', 'Start a session first')

  const dead = await composer.evaluate((el) => ({
    row: getComputedStyle(el.querySelector('.composer-row')!).opacity,
    panel: getComputedStyle(el).backgroundColor,
    caret: getComputedStyle(el.querySelector('.composer-input')!).caretColor,
  }))
  expect(Number(dead.row)).toBeLessThan(1)
  // The block caret is the composer's "ready" signal; a green cursor blinking in
  // a box that cannot send is the wrong promise.
  expect(dead.caret).toBe('rgba(0, 0, 0, 0)')

  // The contrast that matters: a project whose session is still live is not dimmed,
  // so this is a state and not a new permanent look for the composer.
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

  // All six. A picker that offers four of six quietly decides for you.
  for (const mode of ['default', 'dontAsk', 'auto', 'acceptEdits', 'plan', 'bypass']) {
    await expect(list.getByTestId(`start-mode-${mode}`)).toBeVisible()
  }

  // The description is on the row itself and repeated on hover.
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

  // The picker closes on selection, so a warning that lived only inside the list
  // would vanish at the moment it started mattering.
  await expect(page.getByTestId('start-mode-list')).toHaveCount(0)
  await expect(page.getByTestId('bypass-warning')).toContainText('Nothing will ask for approval')

  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-plan').click()
  await expect(page.getByTestId('bypass-warning')).toHaveCount(0)
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
  // The button says what it will do, so the choice is legible before the click.
  await expect(page.getByTestId('start-session')).toContainText('Resume')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ projectId: 'p-alpha', resume: true })
})

test('Resume is refused when there is no conversation to resume', async ({ page }) => {
  // Start a fresh session and end it again before it ever reaches an SDK session
  // id. Offering to resume that would be an offer to restore nothing.
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  await page.getByTestId('end-session').click()
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  const resume = page.getByTestId('resume-session')
  await expect(resume).toBeDisabled()
  await expect(resume).toHaveAttribute('aria-checked', 'false')
})

test('resuming a native session never offers bypass, because its transcript is on this machine', async ({
  page,
}) => {
  await page.getByTestId('resume-session').click()
  await page.getByTestId('start-mode-picker').click()
  const list = page.getByTestId('start-mode-list')
  await expect(list.getByTestId('start-mode-default')).toBeVisible()
  // Resuming a host session inside a container would look for a transcript that
  // is not there and silently find nothing, so the pair is not offered at all.
  await expect(list.getByTestId('start-mode-bypass')).toHaveCount(0)
  await expect(list).toContainText('on this machine')
})

test('a start that crashes immediately surfaces its reason as the start error', async ({ page }) => {
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  // sessions.start already resolved "success" here — the run loop dies a beat
  // later, exactly the race this fix closes. Read the live session id back off
  // the project list rather than the mock's own counter, so the test does not
  // depend on how ids happen to be minted.
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
  // Ended, not still "working" behind a stale pill.
  await expect(page.getByTestId('ended-banner')).toBeVisible()
})

test('a failed resume turns Resume back off, and says why in the message', async ({ page }) => {
  // The seeded ended session already has an sdkSessionId (see beforeEach), so
  // Resume is available without another round-trip through start/end.
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
  // Off for the next click — a retry must not silently repeat the same resume.
  await expect(page.getByTestId('resume-session')).toHaveAttribute('aria-checked', 'false')
})

// On by default since a fresh install should not have to visit the Models tab to
// get fan-out (see DEFAULT_SETTINGS). What still has to hold is the reverse trip:
// a default the developer cannot switch off is a policy, not a default.
test('heavy subagent mode is on by default and can be turned off', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-term').click()
  const toggle = page.getByTestId('setting-heavy-subagents')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  // It survives closing the panel, because it shapes every session that starts after.
  await page.getByTestId('settings-done').click()
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-term').click()
  await expect(page.getByTestId('setting-heavy-subagents')).toHaveAttribute('aria-checked', 'false')
})

// WHERE a session runs used to be decided for you: bypass meant a container and
// everything else meant your own machine, with no way to ask for isolation
// without also giving away every permission prompt. The switch separates the two
// questions, and these hold it apart from the mode picker beside it.
test('a session can be asked to run in a container without choosing bypass', async ({ page }) => {
  const toggle = page.getByTestId('run-in-container')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('start-session').click()
  // A start resolves after a simulated spawn delay, so poll rather than read once.
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1)?.containerised)
    .toBe(true)
  // The point of the switch: isolation WITHOUT handing over the permission gate.
  const last = (await page.evaluate(() => window.__mock.state().starts)).at(-1)
  expect(last?.bypassPermissions).toBe(false)
})

test('a native start is what happens when the switch is left alone', async ({ page }) => {
  await page.getByTestId('start-session').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1)?.containerised)
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
  // Clicking a locked switch must not silently turn the container OFF for a mode
  // that has no other isolation boundary.
  await toggle.click({ force: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
})
