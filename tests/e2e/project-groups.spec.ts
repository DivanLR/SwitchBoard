import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

async function createGroup(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByTestId('new-group').click()
  const input = page.getByTestId('group-rename-input-New group')
  await expect(input).toBeVisible()
  await input.fill(name)
  await input.press('Enter')
  await expect(page.getByTestId(`group-head-${name}`)).toBeVisible()
}

test('a group colour can be picked from its menu', async ({ page }) => {
  await createGroup(page, 'Work')
  const swatch = page.getByTestId('group-head-Work').locator('.group-swatch')
  const head = page.getByTestId('group-head-Work')
  await expect(swatch).toHaveAttribute('style', /--green/)
  await expect(head).toHaveClass(/tinted/)
  await expect(head).toHaveAttribute('style', /--group-tint:\s*var\(--green\)/)
  await head.click({ button: 'right' })
  await expect(page.getByTestId('ctx-color-0')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('ctx-color-2').click()
  await expect(page.getByTestId('project-ctx-menu')).toHaveCount(0)
  await expect(swatch).toHaveAttribute('style', /--blue/)
  await expect(head).toHaveAttribute('style', /--group-tint:\s*var\(--blue\)/)
  await expect(page.getByTestId('group-head-ungrouped')).not.toHaveClass(/tinted/)
})

test('a group can be created and named inline', async ({ page }) => {
  await createGroup(page, 'Work')
  await expect(page.getByTestId('group-count-Work')).toHaveText('0')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
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
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/x-sb-project', 'p-alpha')
    document
      .querySelector('[data-testid="group-head-Work"]')
      ?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  })
  await expect(page.getByTestId('group-count-Work')).toHaveText('1')
  await expect(page.getByTestId('group-count-ungrouped')).toHaveText('1')

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

test('an empty group says what it is for, and the tail is labelled Ungrouped', async ({ page }) => {
  await createGroup(page, 'Work')
  await expect(page.getByTestId('group-empty-Work')).toContainText('Drag a project here')

  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()
  await expect(page.getByTestId('group-empty-Work')).toHaveCount(0)
  await expect(page.getByTestId('group-head-ungrouped')).toContainText('Ungrouped')
})

test('the ungrouped tail folds like any other section', async ({ page }) => {
  await createGroup(page, 'Work')
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()

  await page.getByTestId('group-head-ungrouped').click()
  await expect(page.getByTestId('sidebar-project-beta')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()

  await page.getByTestId('group-head-ungrouped').click()
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
})

test('filtering opens a folded group that holds a match, and hides the rest', async ({ page }) => {
  await createGroup(page, 'Work')
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()
  await page.getByTestId('group-head-Work').click() 
  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)

  await page.getByTestId('project-filter').fill('alph')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('group-head-ungrouped')).toHaveCount(0)

  await page.getByTestId('project-filter-clear').click()
  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)
})

test('the header counts the projects on screen', async ({ page }) => {
  await expect(page.getByTestId('project-count')).toHaveText('2')
  await page.getByTestId('project-filter').fill('alph')
  await expect(page.getByTestId('project-count')).toHaveText('1')
})

test('the collapsed rail ignores grouping and still lists every project', async ({ page }) => {
  await createGroup(page, 'Work')
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-move-to-Work').click()
  await page.getByTestId('group-head-Work').click() 
  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)

  await page.getByTestId('collapse-toggle').click()
  await expect(page.getByTestId('group-head-Work')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
})

test('the sidebar filter narrows the list by name and by branch', async ({ page }) => {
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()

  await page.getByTestId('project-filter').fill('alph')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('sidebar-project-beta')).toHaveCount(0)

  await page.getByTestId('project-filter-clear').click()
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()

  await page.getByTestId('project-filter').fill('zzz-no-such-project')
  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)
  await page.getByTestId('project-filter').press('Escape')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})
