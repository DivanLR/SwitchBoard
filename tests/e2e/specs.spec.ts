// Specs (Spec Kit) view: session/specs tabs, install prompt when not set up,
// and rendering of specs with the docs/clarify/tasks parts.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

test('a project without Spec Kit shows an install button', async ({ page }) => {
  await page.getByTestId('tab-specs').click()
  await expect(page.getByTestId('specs-not-installed')).toBeVisible()
  await expect(page.getByTestId('specs-install')).toBeVisible()
  // Installing scaffolds it and switches to the spec list.
  await page.getByTestId('specs-install').click()
  await expect(page.getByTestId('spec-chip-001-example')).toBeVisible()
})

test('a project with specs shows chips, progress, and tasks', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      specs: [{ id: '001-cart-race', title: 'Cart Race Fix', status: 'in_progress', tasksTotal: 3, tasksDone: 1 }],
      details: {
        '001-cart-race': {
          id: '001-cart-race',
          title: 'Cart Race Fix',
          status: 'in_progress',
          tasksTotal: 3,
          tasksDone: 1,
          description: 'Version the cart state to fix the race.',
          path: 'specs/001-cart-race',
          sections: [{ title: 'Summary', body: 'Version cart state and reconcile by version.' }],
          phases: [
            {
              label: 'Phase 1: Setup',
              tasks: [
                { id: 'T001', label: 'Reproduce the race', done: true },
                { id: 'T002', label: 'Version the cart state', done: false },
                { id: 'T003', label: 'Add regression test', done: false },
              ],
            },
          ],
          clarifications: [],
        },
      },
    }),
  )
  // Reload the project so specs state is fetched.
  await page.getByTestId('sidebar-project-beta').click()
  await page.getByTestId('sidebar-project-alpha').click()

  // The specs tab badge shows the count.
  await expect(page.getByTestId('tab-specs')).toContainText('1')
  await page.getByTestId('tab-specs').click()

  await expect(page.getByTestId('spec-chip-001-cart-race')).toBeVisible()
  await expect(page.getByTestId('specs-view')).toContainText('Cart Race Fix')
  await expect(page.getByTestId('specs-view')).toContainText('1/3 tasks')

  // Tasks part is default; shows done and todo tasks.
  await expect(page.getByTestId('task-done')).toHaveCount(1)
  await expect(page.getByTestId('task-todo')).toHaveCount(2)

  // Switch to the spec (docs) part.
  await page.getByTestId('part-spec').click()
  await expect(page.getByTestId('spec-sections')).toContainText('Version cart state')
})

test('the composer stays visible on the Specs tab (chat is always reachable)', async ({ page }) => {
  await page.getByTestId('tab-specs').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await page.getByTestId('tab-session').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
})

test('+ New spec prefills the composer with the specify command', async ({ page }) => {
  await seedSpec(page)
  await page.getByTestId('spec-new').click()
  await expect(page.getByTestId('composer-input')).toHaveValue('/speckit-specify ')
})

async function seedSpec(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      specs: [{ id: '001-x', title: 'X', status: 'in_progress', tasksTotal: 2, tasksDone: 0 }],
      details: {
        '001-x': {
          id: '001-x', title: 'X', status: 'in_progress', tasksTotal: 2, tasksDone: 0,
          description: 'desc', path: 'specs/001-x',
          sections: [{ title: 'Summary', body: 'body' }],
          phases: [{ label: 'Phase 1: Core', tasks: [
            { id: 'T001', label: 'Do a thing', done: false },
            { id: 'T002', label: 'Do another', done: false },
          ] }],
          clarifications: ['which approach?'],
          resolvedClarifications: [{ question: 'Which DB?', answer: 'SQLite.' }],
        },
      },
    }),
  )
  await page.getByTestId('sidebar-project-beta').click()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-specs').click()
}

test('the Commands part suggests the next stage and lists all commands', async ({ page }) => {
  await seedSpec(page)
  await page.getByTestId('part-cmds').click()
  await expect(page.getByTestId('speckit-commands')).toBeVisible()
  // One open clarification → the suggested next stage is /speckit.clarify.
  await expect(page.getByTestId('suggested-next')).toContainText('/speckit.clarify')
  await expect(page.getByTestId('suggested-next')).toContainText('1 open clarification')
  await page.getByTestId('speckit-cmd-speckit-clarify').click()
  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.some((s) => s.text === '/speckit-clarify 001-x')).toBe(true)
})

test('clarify part shows both open and already-resolved clarifications', async ({ page }) => {
  await seedSpec(page)
  await page.getByTestId('part-clarify').click()
  await expect(page.getByTestId('spec-clarify')).toContainText('which approach?')
  await expect(page.getByTestId('resolved-clarification')).toContainText('Which DB?')
  await expect(page.getByTestId('resolved-clarification')).toContainText('SQLite.')
})

test('start phase sends an implement command and shows the implementing state', async ({ page }) => {
  await seedSpec(page)
  await page.getByTestId('part-tasks').click()
  await page.getByTestId('start-phase-Phase 1: Core').click()
  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.some((s) => s.text.includes('Phase 1: Core'))).toBe(true)
  await expect(page.getByTestId('implementing')).toBeVisible()
})
