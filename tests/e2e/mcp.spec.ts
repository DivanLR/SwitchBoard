// Database MCP as a GLOBAL, project-less session: the reserved "Database"
// project backs a single sidebar MCP row that is not gated on selecting a
// regular project. It starts on demand (the DB view's start button), not at
// launch. Opening it runs a multi-agent scan to db-schema.md and chats with
// the DB as live queries.
import { expect, test } from '@playwright/test'
import { installMockHost, type MockScenario } from './mock-host'

/** alpha is an ordinary selected project; the reserved row hosts the DB session
 *  reporting its MCP roster (surfaced as the connection pill). */
function dbScenario(): MockScenario {
  return {
    projects: [
      {
        id: 'p-alpha',
        name: 'alpha',
        path: 'C:\\work\\alpha',
        session: { id: 's-alpha', status: 'working', branch: 'main' },
      },
      {
        id: 'p-db',
        name: 'Database',
        path: 'C:\\userdata\\database-mcp',
        reserved: true,
        session: {
          id: 's-db',
          status: 'working',
          mcpServers: [
            { name: 'postgres — production', status: 'connected' },
            { name: 'github', status: 'connected' },
            { name: 'filesystem', status: 'connected' },
            { name: 'playwright', status: 'connected' },
            { name: 'context7', status: 'connected' },
          ],
        },
      },
    ],
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, dbScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

const mcpRow = '[data-testid^="mcp-server-"]'

/** Designate the DB MCP via Settings → MCP (the sidebar row is hidden until one is chosen). */
async function designateDbMcp(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-mcp').click()
  await page.getByTestId('db-mcp-postgres — production').click()
  await page.getByTestId('settings-done').click()
}

test('the reserved Database row is hidden as a project and shown only once designated', async ({
  page,
}) => {
  // The reserved project must never appear in the PROJECTS list.
  await expect(page.getByTestId('sidebar-project-Database')).toHaveCount(0)
  // No MCP row until a database server is designated.
  await expect(page.locator(mcpRow)).toHaveCount(0)
  await designateDbMcp(page)
  await expect(page.locator(mcpRow)).toHaveCount(1)
  await expect(page.getByTestId('mcp-server-postgres — production')).toBeVisible()
})

test('the global MCP row opens the Database view and scans to db-schema.md', async ({ page }) => {
  await designateDbMcp(page)
  await page.locator(mcpRow).first().click()
  const view = page.getByTestId('mcp-view')
  await expect(view).toBeVisible()
  await expect(page.getByTestId('mcp-chip-postgres — production')).toBeVisible()
  // Unscanned → the scan call-to-action (a live session already exists).
  await expect(page.getByTestId('mcp-empty')).toContainText('No schema map yet')

  await page.getByTestId('mcp-scan').click()
  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(
    sends.some(
      (t) => /scan these mcp servers/i.test(t) && t.includes('"postgres — production"') && t.includes('db-schema.md'),
    ),
  ).toBe(true)
})

test('a completed scan unlocks db-schema.md and chat runs a DB-targeted query', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setMcpSchema('p-db', '# db-schema.md\n\n## public.users\n\n- `id` uuid PK\n'),
  )
  await designateDbMcp(page)
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
      (t) => t.includes('[MCP: "postgres — production"]') && t.includes('signed up this month'),
    ),
  ).toBe(true)

  // Back closes the view and returns to the selected project's session.
  await page.getByTestId('mcp-close').click()
  await expect(page.getByTestId('mcp-view')).toHaveCount(0)
  await expect(page.getByTestId('stream')).toBeVisible()
})

test('two designated servers combine into one chat and one scan', async ({ page }) => {
  // Designate a database MCP and a code-search MCP together.
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-mcp').click()
  await page.getByTestId('db-mcp-postgres — production').click()
  await page.getByTestId('db-mcp-github').click()
  await page.getByTestId('settings-done').click()

  // Both show as sidebar MCP rows; each opens the same combined view.
  await expect(page.locator(mcpRow)).toHaveCount(2)
  await page.getByTestId('mcp-server-github').click()
  await expect(page.getByTestId('mcp-chip-postgres — production')).toBeVisible()
  await expect(page.getByTestId('mcp-chip-github')).toBeVisible()

  // A scan and a question both span both servers in one prompt.
  await page.getByTestId('mcp-scan').click()
  await page.getByTestId('mcp-tab-chat').click()
  await page.getByTestId('mcp-composer').fill('cross-reference the users table with the repo')
  await page.getByTestId('mcp-send').click()
  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(
    sends.some(
      (t) => t.includes('"postgres — production"') && t.includes('"github"') && t.includes('db-schema.md'),
    ),
  ).toBe(true)
  expect(
    sends.some(
      (t) => t.startsWith('[MCP:') && t.includes('"postgres — production"') && t.includes('"github"'),
    ),
  ).toBe(true)
})

test('the manual start runs a normal session with no MCP server denied', async ({ page }) => {
  await designateDbMcp(page)
  await page.locator(mcpRow).first().click()
  await expect(page.getByTestId('mcp-view')).toBeVisible()

  // End the reserved session so the view offers a fresh start.
  await page.evaluate(() => window.__mock.endSession('s-db'))
  await page.getByTestId('mcp-start-session').click()

  // The database session starts like any project session — no deny-list.
  const starts = await page.evaluate(() => window.__mock.state().starts)
  const dbStart = starts.find((s) => s.projectId === 'p-db')
  expect(dbStart).toBeTruthy()
  expect(dbStart?.deniedMcpServers ?? []).toEqual([])
})
