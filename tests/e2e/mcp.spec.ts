import { expect, test } from '@playwright/test'
import { installMockHost, type MockScenario } from './mock-host'
import { DEFAULT_SETTINGS } from '../../src/shared/domain'

function dbScenario(): MockScenario {
  return {
    settings: DEFAULT_SETTINGS,
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

async function designateDbMcp(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-mcp').click()
  await page.getByTestId('db-mcp-postgres — production').click()
  await page.getByTestId('settings-done').click()
}

test('the reserved Database row is hidden as a project and shown only once designated', async ({
  page,
}) => {
  await expect(page.getByTestId('sidebar-project-Database')).toHaveCount(0)
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
  await expect(page.getByTestId('mcp-empty')).toContainText('No schema map yet')

  await page.getByTestId('mcp-scan').click()
  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(
    sends.some(
      (t) =>
        /scan these mcp servers/i.test(t) &&
        t.includes('"postgres — production"') &&
        t.includes('.switchboard/scans/'),
    ),
  ).toBe(true)
})

test('a completed scan unlocks db-schema.md and chat runs a DB-targeted query', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setMcpSchema('p-db', '# db-schema.md\n\n## public.users\n\n- `id` uuid PK\n', [
      'postgres — production',
    ]),
  )
  await designateDbMcp(page)
  await page.locator(mcpRow).first().click()

  await page.getByTestId('mcp-tab-md').click()
  await expect(page.getByTestId('mcp-doc')).toContainText('public.users')

  await page.getByTestId('mcp-tab-chat').click()
  await page.getByTestId('mcp-composer').fill('How many users signed up this month?')
  await page.getByTestId('mcp-send').click()
  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(
    sends.some(
      (t) => t.includes('[MCP: "postgres — production"]') && t.includes('signed up this month'),
    ),
  ).toBe(true)

  await page.getByTestId('sidebar-project-alpha').click()
  await expect(page.getByTestId('mcp-view')).toHaveCount(0)
  await expect(page.getByTestId('stream')).toBeVisible()
})

test('two designated servers combine into one chat and one scan', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-mcp').click()
  await page.getByTestId('db-mcp-postgres — production').click()
  await page.getByTestId('db-mcp-github').click()
  await page.getByTestId('settings-done').click()

  await expect(page.locator(mcpRow)).toHaveCount(2)
  await page.getByTestId('mcp-server-github').click()
  await expect(page.getByTestId('mcp-chip-postgres — production')).toBeVisible()
  await expect(page.getByTestId('mcp-chip-github')).toBeVisible()

  await page.getByTestId('mcp-scan').click()
  await page.getByTestId('mcp-tab-chat').click()
  await page.getByTestId('mcp-composer').fill('cross-reference the users table with the repo')
  await page.getByTestId('mcp-send').click()
  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(
    sends.some(
      (t) =>
        t.includes('"postgres — production"') &&
        t.includes('"github"') &&
        t.includes('.switchboard/scans/'),
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

  await page.evaluate(() => window.__mock.endSession('s-db'))
  await page.getByTestId('mcp-start-session').click()

  await expect
    .poll(async () =>
      (await page.evaluate(() => window.__mock.state().starts)).some((s) => s.projectId === 'p-db'),
    )
    .toBe(true)
  const starts = await page.evaluate(() => window.__mock.state().starts)
  const dbStart = starts.find((s) => s.projectId === 'p-db')
  expect(dbStart?.deniedMcpServers ?? []).toEqual([])
})

test('unticking a server drops it from the combination; each combo keeps its own doc', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mock.setMcpSchema('p-db', '# combined map\n', ['github', 'postgres — production'])
    window.__mock.setMcpSchema('p-db', '# postgres-only map\n', ['postgres — production'])
  })
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-mcp').click()
  await page.getByTestId('db-mcp-postgres — production').click()
  await page.getByTestId('db-mcp-github').click()
  await page.getByTestId('settings-done').click()
  await page.locator(mcpRow).first().click()

  await expect(page.getByTestId('mcp-combo-name')).toHaveText('github + postgres — production')
  await page.getByTestId('mcp-tab-md').click()
  await expect(page.getByTestId('mcp-doc')).toContainText('combined map')

  await page.getByTestId('mcp-chip-github').click()
  await expect(page.getByTestId('mcp-combo-name')).toHaveText('postgres — production')
  await expect(page.getByTestId('mcp-doc')).toContainText('postgres-only map')

  await page.getByTestId('mcp-tab-chat').click()
  await page.getByTestId('mcp-chip-postgres — production').click()
  await expect(page.getByTestId('mcp-empty')).toBeVisible()
  await expect(page.getByTestId('mcp-scan')).toBeDisabled()
})

test('a finished scan lands in the combination history and can be re-activated', async ({
  page,
}) => {
  await designateDbMcp(page)
  await page.locator(mcpRow).first().click()

  await page.evaluate(() =>
    window.__mock.setMcpSchema('p-db', '# scanned map\n', ['postgres — production']),
  )
  await page.getByTestId('mcp-scan').click()
  await page.evaluate(() => window.__mock.setStatus('s-db', 'done'))

  await expect(page.getByTestId('mcp-combo-scanned')).toContainText('scanned')
  await expect(page.getByTestId('mcp-history-postgres — production')).toBeVisible()

  await page.getByTestId('mcp-chip-postgres — production').click()
  await expect(page.getByTestId('mcp-combo-name')).toHaveCount(0)
  await page.getByTestId('mcp-history-postgres — production').click()
  await expect(page.getByTestId('mcp-combo-name')).toHaveText('postgres — production')
  await expect(page.getByTestId('mcp-combo-scanned')).toContainText('scanned')
})
