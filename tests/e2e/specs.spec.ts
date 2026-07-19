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

test('the session tab still shows the stream and composer', async ({ page }) => {
  await page.getByTestId('tab-specs').click()
  await expect(page.getByTestId('composer-input')).toHaveCount(0)
  await page.getByTestId('tab-session').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
})
