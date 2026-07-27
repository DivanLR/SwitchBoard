// Tests section shell — the design's verify surface: pick a stack, read the six
// gates, drill into a panel. What the app cannot measure yet must SAY so rather
// than show a figure nothing produced (spec 002 FR-072).
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('tests-view')).toBeVisible()
})

test('the section opens on a stack picker seeded by detection', async ({ page }) => {
  await expect(page.getByTestId('tests-detect-hint')).toContainText('Node / Vue / Electron')
  await expect(page.getByTestId('tests-stack-dotnet')).toBeVisible()
  await expect(page.getByTestId('tests-stack-angular')).toBeVisible()
  await expect(page.getByTestId('tests-stack-python')).toBeVisible()
  // Detection is a hint, not a decision: the detected stack is only marked.
  await expect(page.getByTestId('tests-stack-node')).toContainText('DETECTED')
  await expect(page.getByTestId('tests-stack-dotnet')).not.toContainText('DETECTED')
})

test('a chosen stack shows the six gates, and the unmeasured ones say so', async ({ page }) => {
  await page.getByTestId('tests-stack-node').click()

  // Built gates read their state from the acceptance lines; nothing has run yet.
  for (const id of ['unit', 'integration', 'architecture']) {
    await expect(page.getByTestId(`tests-gate-${id}`)).toContainText('not run');
    await expect(page.getByTestId(`tests-gate-${id}`)).toBeEnabled()
  }
  // Nothing measures these, so they are inert and labelled — never a number.
  for (const id of ['mutation', 'coverage', 'quality-service']) {
    await expect(page.getByTestId(`tests-gate-${id}`)).toContainText('in development')
    await expect(page.getByTestId(`tests-gate-${id}`)).toBeDisabled()
  }
  // The gate's own threshold is on the tile, so the target is never implied.
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('≥ 80% line')
})

test('Manual QA is the live panel; the rest are marked in development', async ({ page }) => {
  await page.getByTestId('tests-stack-node').click()

  // Manual QA is the default and carries the real eval loop.
  await expect(page.getByTestId('evals-view')).toBeVisible()

  for (const [sub, text] of [
    ['coverage', 'FILES YOU TOUCHED'],
    ['quality', 'QUALITY BAR'],
    ['evidence', 'SCREENSHOTS FROM THE RUN'],
    ['skill', 'WHAT A FULL RUN EXECUTES'],
  ] as const) {
    await page.getByTestId(`tests-sub-${sub}`).click()
    const panel = page.getByTestId(`tests-dev-${sub}`)
    await expect(panel).toContainText('in development')
    await expect(panel).toContainText(text)
    // The eval loop is not on screen while an unbuilt panel is showing.
    await expect(page.getByTestId('evals-view')).toHaveCount(0)
  }

  await page.getByTestId('tests-sub-qa').click()
  await expect(page.getByTestId('evals-view')).toBeVisible()
})

test('a gate tile jumps to the panel that would explain it', async ({ page }) => {
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-gate-architecture').click()
  await expect(page.getByTestId('tests-dev-quality')).toBeVisible()
})

test('running verification sends every suite of the chosen stack to the session', async ({ page }) => {
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()

  const sent = await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)
  expect(sent).toContain('Verify the working tree')
  expect(sent).toContain('npm test')
  expect(sent).toContain('Do not fix anything')
})

test('only the working tree is scopeable; the other targets are marked', async ({ page }) => {
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-target-tree')).toBeEnabled()
  await expect(page.getByTestId('tests-target-head')).toBeDisabled()
  await expect(page.getByTestId('tests-target-head')).toContainText('in development')
  await expect(page.getByTestId('tests-target-spec')).toBeDisabled()
})

test('the stack choice persists per project and can be changed', async ({ page }) => {
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-run')).toBeVisible()

  // Leave the section and come back: no picker, the choice stuck.
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('tests-run')).toBeVisible()

  await page.getByTestId('tests-change-stack').click()
  await expect(page.getByTestId('tests-stack-node')).toBeVisible()
})
