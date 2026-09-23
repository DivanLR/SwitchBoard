import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { seedRealApp, type SeededApp } from './seed-real-app'

let app: ElectronApplication
let page: Page
let seed: SeededApp

test.beforeAll(async () => {
  seed = seedRealApp()
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${seed.userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      USERPROFILE: seed.userDataDir,
      HOME: seed.userDataDir,
      APPDATA: seed.userDataDir,
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
  await app?.close().catch(() => {})
  for (const dir of [seed?.userDataDir, seed?.projectPath]) {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

test('real Electron rejects the unguarded request, exactly as it did when this broke', async () => {
  const message = await page.evaluate(async () => {
    const reactiveLike = new Proxy(['dotnet-unit', 'dotnet-http'], {})
    try {
      await window.switchboard.invoke('verify.start', {
        projectId: 'x',
        stackId: 'dotnet',
        suiteIds: reactiveLike,
      } as never)
      return null
    } catch (error) {
      return String((error as { message?: string }).message ?? error)
    }
  })
  expect(message).toMatch(/could not be cloned/i)
})

test('the Tests section opens the seeded .NET project with all seven suites', async () => {
  await page.getByTestId('sidebar-project-sample-api').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('tests-view')).toBeVisible()

  for (const id of [
    'dotnet-unit',
    'dotnet-coverage',
    'dotnet-api',
    'dotnet-http',
    'dotnet-arch',
    'dotnet-format',
    'dotnet-mutation',
  ]) {
    await expect(page.getByTestId(`tests-suite-${id}`)).toBeVisible()
  }
  await expect(page.getByTestId('tests-suite-dotnet-http')).toContainText('real endpoints')

  await expect(page.getByTestId('tests-suite-blazor-ui')).toHaveCount(0)
  await expect(page.getByTestId('tests-suite-blazor-interactive')).toHaveCount(0)
  await expect(page.getByTestId('tests-view')).toContainText('.NET API')
})

test('the real application renders endpoint results with the row behind each call', async () => {
  await page.getByTestId('sidebar-project-sample-api').click()
  await page.getByTestId('tab-tests').click()
  await page.getByTestId('tests-sub-evidence').click()

  const passing = page.getByTestId('tests-endpoint-0')
  await expect(passing).toContainText('GET')
  await expect(passing).toContainText('/api/v1/policies/PL-88213')
  await expect(passing).toContainText('200')
  await expect(passing).toContainText('96 ms')
  await expect(passing).toContainText('postgres-reporting')
  await expect(passing).toContainText("select id from policies where status = 'Active'")
  await expect(passing).toContainText('the row lists 3 contracts; the response listed 3')

  const wrong = page.getByTestId('tests-endpoint-1')
  await expect(wrong).toContainText('fail')
  await expect(wrong).toContainText('200')
  await expect(wrong).toContainText('this must be a 404')

  const refused = page.getByTestId('tests-endpoint-2')
  await expect(refused).toContainText('not run')
  await expect(refused).toContainText('does not point at a test database')
  await expect(refused).toContainText('—')

  await expect(page.getByTestId('tests-panel-evidence')).toContainText('REAL ENDPOINTS, REAL DATA')

  if (process.env.REAL_APP_SHOT) {
    await page.getByTestId('tests-endpoint-2').scrollIntoViewIfNeeded()
    await page.screenshot({ path: process.env.REAL_APP_SHOT })
  }
  await expect(page.getByTestId('tests-gate-integration')).toContainText('failed')
})

test('Run verification crosses the real boundary without the clone error', async () => {
  await page.getByTestId('sidebar-project-sample-api').click()
  await page.getByTestId('tab-tests').click()
  await page.getByTestId('tests-suite-dotnet-mutation').click()
  await expect(page.getByTestId('tests-suite-count')).toContainText('9 of 9')

  await page.getByTestId('tests-run').click()

  const banner = page.getByTestId('tests-error')
  await expect(banner).toBeVisible()
  const message = (await banner.textContent()) ?? ''
  expect(message).not.toMatch(/could not be cloned/i)
  expect(message).toMatch(/Claude Code was not found/i)
})

test('a second sidebar group can be created, and both persist', async () => {
  const createGroup = async (name: string): Promise<void> => {
    await page.getByTestId('new-group').click()
    const input = page.getByTestId('group-rename-input-New group')
    await expect(input).toBeVisible()
    await input.fill(name)
    await input.press('Enter')
    await expect(page.getByTestId(`group-head-${name}`)).toBeVisible()
  }

  await createGroup('Work')
  await createGroup('Clients')

  await expect(page.getByTestId('group-head-Work')).toBeVisible()
  await expect(page.getByTestId('group-head-Clients')).toBeVisible()

  const names = await page.evaluate(async () => {
    const settings = await window.switchboard.invoke('settings.get', undefined)
    return settings.projectGroups.map((group) => group.name)
  })
  expect(names).toEqual(['Work', 'Clients'])
})

const groupNames = (): Promise<string[]> =>
  page.evaluate(async () => {
    const settings = await window.switchboard.invoke('settings.get', undefined)
    return settings.projectGroups.map((group) => group.name)
  })

async function clearGroups(): Promise<void> {
  await page.evaluate(async () => {
    await window.switchboard.invoke('settings.set', { projectGroups: [], projectGroupOf: {} })
  })
  await page.reload()
  await expect(page.getByTestId('new-group')).toBeVisible()
}

test('naming a group and then clicking New group keeps the name', async () => {
  await clearGroups()
  await page.getByTestId('new-group').click()
  await page.getByTestId('group-rename-input-New group').fill('Work')
  await page.getByTestId('new-group').click()

  await expect(page.getByTestId('group-head-Work')).toBeVisible()
  expect(await groupNames()).toEqual(['Work', 'New group'])
})

test('two group creations in the same tick both survive, distinctly named', async () => {
  await clearGroups()
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="new-group"]') as HTMLButtonElement
    button.click()
    button.click()
  })

  await expect(page.getByTestId('group-head-New group 2')).toBeVisible()
  expect(await groupNames()).toEqual(['New group', 'New group 2'])
})

test('the UI runs on its own origin, not file://', async () => {
  const origin = await page.evaluate(() => window.location.origin)
  expect(origin).toBe('app://bundle')
})

test('the content security policy is live on that origin', async () => {
  const escaped = await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__cspEscaped = true'
    document.head.appendChild(script)
    script.remove()
    return (window as unknown as { __cspEscaped?: boolean }).__cspEscaped === true
  })
  expect(escaped).toBe(false)
})

test('renderer web permissions are still denied, clipboard included', async () => {
  const states = await page.evaluate(async () => {
    const query = async (name: string): Promise<string> => {
      try {
        const status = await navigator.permissions.query({ name } as unknown as PermissionDescriptor)
        return status.state
      } catch {
        return 'unsupported'
      }
    }
    return { write: await query('clipboard-write'), read: await query('clipboard-read') }
  })

  expect(states.write).not.toBe('granted')
  expect(states.read).not.toBe('granted')
})

test('copying goes through the main process, so it works despite that', async () => {
  const failure = await page.evaluate(async () => {
    try {
      await window.switchboard.invoke('clipboard.write', { text: 'switchboard clipboard probe' })
      return null
    } catch (error) {
      return String(error)
    }
  })
  expect(failure).toBeNull()
})

test('the Terminal tab runs a real shell and shows its output', async () => {
  await page.getByTestId('sidebar-project-sample-api').click()
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-terminal').click()
  await expect(page.getByTestId('conversation-terminal')).toBeVisible()
  await page.getByTestId('conversation-terminal-shell').click()

  const pane = page.getByTestId('terminal-pane')
  await expect(pane).toBeVisible()
  await expect.poll(async () => (await pane.locator('.xterm-rows div').count()) > 0).toBe(true)

  await expect
    .poll(async () => (await pane.locator('.xterm-rows').innerText()).trim().length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
})
