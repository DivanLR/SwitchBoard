import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

const CHANGES = [
  { path: 'package.json', status: 'modified', addedLines: 1, removedLines: 1, binary: false },
  { path: 'src/app.ts', status: 'modified', addedLines: 3, removedLines: 1, binary: false },
  { path: 'src/main.ts', status: 'added', addedLines: 12, removedLines: 0, binary: false },
  {
    path: 'src/renderer/View.vue',
    status: 'modified',
    addedLines: 4,
    removedLines: 2,
    binary: false,
  },
  { path: 'docs/logo.png', status: 'added', addedLines: null, removedLines: null, binary: true },
]

async function openDiff(page: import('@playwright/test').Page): Promise<void> {
  const scenario = twoProjectScenario()
  scenario.projects[0].diff = { gitNotice: null, files: CHANGES }
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('diff-file-list')).toBeVisible()
}

test('files are grouped under the folder that holds them', async ({ page }) => {
  await openDiff(page)

  await expect(page.getByTestId('diff-folder-root')).toBeVisible()
  await expect(page.getByTestId('diff-folder-src')).toBeVisible()
  await expect(page.getByTestId('diff-folder-src/renderer')).toBeVisible()
  await expect(page.getByTestId('diff-folder-docs')).toBeVisible()

  const headings = page.locator('.diff-folder')
  await expect(headings).toHaveCount(4)
  await expect(headings.nth(0)).toHaveAttribute('data-testid', 'diff-folder-root')
  await expect(headings.nth(1)).toHaveAttribute('data-testid', 'diff-folder-docs')
  await expect(headings.nth(2)).toHaveAttribute('data-testid', 'diff-folder-src')
  await expect(headings.nth(3)).toHaveAttribute('data-testid', 'diff-folder-src/renderer')
})

test("a folder heading totals everything under it, so a folded folder still reports", async ({ page }) => {
  await openDiff(page)

  await expect(page.getByTestId('diff-folder-src')).toContainText('+19')
  await expect(page.getByTestId('diff-folder-src')).toContainText('−3')
  await expect(page.getByTestId('diff-folder-src')).toContainText('3')

  await expect(page.getByTestId('diff-folder-docs')).toContainText('binary')
})

test('a file row shows its own name, since the heading already said where it is', async ({
  page,
}) => {
  await openDiff(page)
  const row = page.getByTestId('diff-file-src/renderer/View.vue')
  await expect(row).toContainText('View.vue')
  await expect(row).not.toContainText('src/renderer/View.vue')
  await expect(row.locator('.dfr-path')).toHaveAttribute('title', 'src/renderer/View.vue')
})

test('folding a folder hides everything under it, and keeps its heading', async ({ page }) => {
  await openDiff(page)
  await expect(page.getByTestId('diff-file-src/app.ts')).toBeVisible()

  await page.getByTestId('diff-folder-src').click()
  await expect(page.getByTestId('diff-folder-src')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('diff-file-src/app.ts')).toHaveCount(0)
  await expect(page.getByTestId('diff-folder-src/renderer')).toHaveCount(0)
  await expect(page.getByTestId('diff-file-src/renderer/View.vue')).toHaveCount(0)
  await expect(page.getByTestId('diff-file-package.json')).toBeVisible()
  await expect(page.getByTestId('diff-folder-docs')).toBeVisible()

  await page.getByTestId('diff-folder-src').click()
  await expect(page.getByTestId('diff-file-src/app.ts')).toBeVisible()
  await expect(page.getByTestId('diff-folder-src/renderer')).toBeVisible()
})

test('a folder with no files of its own still appears, so the tree has its levels', async ({
  page,
}) => {
  const scenario = twoProjectScenario()
  scenario.projects[0].diff = {
    gitNotice: null,
    files: [
      {
        path: 'src/main/sessions/session.ts',
        status: 'modified',
        addedLines: 5,
        removedLines: 2,
        binary: false,
      },
    ],
  }
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-diff').click()

  await expect(page.getByTestId('diff-folder-src')).toBeVisible()
  await expect(page.getByTestId('diff-folder-src/main')).toBeVisible()
  await expect(page.getByTestId('diff-folder-src/main/sessions')).toBeVisible()
  await expect(page.getByTestId('diff-folder-src/main').locator('.dfo-path')).toHaveText('main')

  await page.getByTestId('diff-folder-src').click()
  await expect(page.getByTestId('diff-folder-src/main')).toHaveCount(0)
  await expect(page.getByTestId('diff-file-src/main/sessions/session.ts')).toHaveCount(0)
})

test('selecting a file still opens its diff, grouped or not', async ({ page }) => {
  await openDiff(page)
  await page.evaluate(() => {
    window.__mock.setFileDiff('p-alpha', 'src/app.ts', {
      binary: false,
      lines: [{ type: 'add', text: 'grouped and still selectable' }],
    })
  })

  await page.getByTestId('diff-file-src/app.ts').click()
  await expect(page.getByTestId('diff-pane-lines')).toContainText('grouped and still selectable')
})
