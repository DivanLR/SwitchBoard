// Collapsible project groups in the sidebar: create, assign, fold, remove.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

/** Creates a group named `name` via the section-row button and inline rename. */
async function createGroup(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByTestId('new-group').click()
  const input = page.getByTestId('group-rename-input-New group')
  await expect(input).toBeVisible()
  await input.fill(name)
  await input.press('Enter')
  await expect(page.getByTestId(`group-head-${name}`)).toBeVisible()
}

test('a group can be created and named inline', async ({ page }) => {
  await createGroup(page, 'Work')
  // A new group starts empty and expanded, and every project stays visible.
  await expect(page.getByTestId('group-count-Work')).toHaveText('0')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
  // Once a group exists, the remaining projects are labelled as ungrouped.
  await expect(page.getByTestId('group-count-ungrouped')).toHaveText('2')
})

test('a project moves into a group from its context menu', async ({ page }) => {
  await createGroup(page, 'Work')
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()
  await expect(page.getByTestId('group-count-Work')).toHaveText('1')
  await expect(page.getByTestId('group-count-ungrouped')).toHaveText('1')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('folding a group hides its projects and leaves the others alone', async ({ page }) => {
  await createGroup(page, 'Work')
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()

  await page.getByTestId('group-head-Work').click()
  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
  // The count stays readable while folded, so the group still says what it holds.
  await expect(page.getByTestId('group-count-Work')).toHaveText('1')

  await page.getByTestId('group-head-Work').click()
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('a folded group still shows the pending count of what it hides', async ({ page }) => {
  await createGroup(page, 'Work')
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()
  await page.evaluate(() =>
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'Run a command: ls' }),
  )
  await expect(page.getByTestId('project-badge-alpha')).toHaveText('1')

  await page.getByTestId('group-head-Work').click()
  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)
  // Folding must not hide the fact that something inside needs attention.
  await expect(page.getByTestId('group-badge-Work')).toHaveText('1')
})

test('removing a group keeps its projects, ungrouped', async ({ page }) => {
  await createGroup(page, 'Work')
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()
  await expect(page.getByTestId('group-count-Work')).toHaveText('1')

  await page.getByTestId('group-remove-Work').click()
  await expect(page.getByTestId('group-head-Work')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
})

test('a group is renamed and reordered from its own context menu', async ({ page }) => {
  await createGroup(page, 'Work')
  await createGroup(page, 'Clients')

  await page.getByTestId('group-head-Clients').click({ button: 'right' })
  await page.getByTestId('ctx-move-up').click()
  const headers = page.locator('[data-testid^="group-head-"]')
  await expect(headers.first()).toHaveAttribute('data-testid', 'group-head-Clients')

  await page.getByTestId('group-head-Work').click({ button: 'right' })
  await page.getByTestId('ctx-rename').click()
  const input = page.getByTestId('group-rename-input-Work')
  await input.fill('Personal')
  await input.press('Enter')
  await expect(page.getByTestId('group-head-Personal')).toBeVisible()
  await expect(page.getByTestId('group-head-Work')).toHaveCount(0)
})

test('dragging a project onto a group header joins that group', async ({ page }) => {
  await createGroup(page, 'Work')
  // Synthetic drop with a real DataTransfer: exercises the drop handler itself
  // rather than simulating mouse movement, which HTML5 drag makes unreliable.
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/x-sb-project', 'p-alpha')
    document
      .querySelector('[data-testid="group-head-Work"]')
      ?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  })
  await expect(page.getByTestId('group-count-Work')).toHaveText('1')
  await expect(page.getByTestId('group-count-ungrouped')).toHaveText('1')

  // Dropping on the Ungrouped divider takes it back out again.
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/x-sb-project', 'p-alpha')
    document
      .querySelector('[data-testid="group-head-ungrouped"]')
      ?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  })
  await expect(page.getByTestId('group-count-Work')).toHaveText('0')
  await expect(page.getByTestId('group-count-ungrouped')).toHaveText('2')
})

test('the collapsed rail ignores grouping and still lists every project', async ({ page }) => {
  await createGroup(page, 'Work')
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()
  await page.getByTestId('group-head-Work').click() // fold it shut
  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)

  await page.getByTestId('collapse-toggle').click()
  // No room for headers on the rail, so grouping is set aside rather than
  // swallowing rows: a folded group must not hide a project from the rail.
  await expect(page.getByTestId('group-head-Work')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
})
