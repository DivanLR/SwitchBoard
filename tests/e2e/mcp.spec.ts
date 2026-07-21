// Database MCP: open the view from the sidebar, run a multi-agent scan that
// targets db-schema.md, then chat with the DB (each question a live query).
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

const mcpRow = '[data-testid^="mcp-server-"]'

test('designating a database MCP in settings collapses the sidebar to only that server', async ({
  page,
}) => {
  // The alpha session reports several MCP servers — all show before designation.
  await expect(page.locator(mcpRow)).toHaveCount(5)

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-gen').click()
  await page.getByTestId('db-mcp-postgres — production').click()
  await page.getByTestId('settings-done').click()

  // Now only the designated database MCP remains in the sidebar section.
  await expect(page.locator(mcpRow)).toHaveCount(1)
  await expect(page.getByTestId('mcp-server-postgres — production')).toBeVisible()
})

test('the sidebar MCP row opens the Database MCP view and scans to db-schema.md', async ({
  page,
}) => {
  await page.locator(mcpRow).first().click()
  const view = page.getByTestId('mcp-view')
  await expect(view).toBeVisible()
  await expect(view).toContainText('postgres — production')
  await expect(page.getByTestId('mcp-conn')).toContainText('Connected')
  // Unscanned → the scan call-to-action.
  await expect(page.getByTestId('mcp-empty')).toContainText('No schema map yet')

  await page.getByTestId('mcp-scan').click()
  // A multi-agent scan prompt is sent to the session, writing db-schema.md.
  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(
    sends.some((t) => /scan the "postgres — production"/i.test(t) && t.includes('db-schema.md')),
  ).toBe(true)
})

test('a completed scan unlocks db-schema.md and chat runs a DB-targeted query', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setMcpSchema('p-alpha', '# db-schema.md\n\n## public.users\n\n- `id` uuid PK\n'),
  )
  await page.locator(mcpRow).first().click()

  // The db-schema.md tab appears and renders the cached map.
  await page.getByTestId('mcp-tab-md').click()
  await expect(page.getByTestId('mcp-doc')).toContainText('public.users')

  // Chat: a question becomes a DB-targeted prompt that consults the map.
  await page.getByTestId('mcp-tab-chat').click()
  await page.getByTestId('mcp-composer').fill('How many users signed up this month?')
  await page.getByTestId('mcp-send').click()
  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(
    sends.some(
      (t) => t.includes('[Database: postgres — production]') && t.includes('signed up this month'),
    ),
  ).toBe(true)

  // Back closes the view and returns to the session.
  await page.getByTestId('mcp-close').click()
  await expect(page.getByTestId('mcp-view')).toHaveCount(0)
  await expect(page.getByTestId('stream')).toBeVisible()
})
