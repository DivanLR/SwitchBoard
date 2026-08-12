// The real application: real main process, real preload, real contextBridge,
// real production renderer bundle. No mock host.
//
// Exists because Run verification failed with "An object could not be cloned"
// and every other spec here mocks `window.switchboard`, which can accept what
// the real contextBridge rejects. The two assertions below are paired: real
// Electron genuinely rejects the unguarded shape, and the button's own path
// now crosses the same boundary intact.
//
// Runs against out/ (`npm run build` first); playwright.real.config.ts keeps
// it out of the renderer-only suite and its dev-server webServer.
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
      // Point HOME at the throwaway tree so resolveClaudeExecutable finds no CLI.
      // This matters: reconcileOnStartup ends the seeded session before the window
      // paints, so without this, Run verification would spawn a REAL Claude Code
      // session and spend real tokens. With no CLI resolvable, startSession fails
      // fast with its install message instead — exactly the discriminator this
      // suite needs, since that complaint is only reachable after crossing the
      // real bridge and handler.
      USERPROFILE: seed.userDataDir,
      HOME: seed.userDataDir,
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  // Closing the window hides to tray (FR-022a) so sessions keep running, which
  // means app.close() waits forever. Exit the process outright instead.
  await app?.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
  await app?.close().catch(() => {})
  // Two temp trees: the userData directory and the fake .NET project.
  for (const dir of [seed?.userDataDir, seed?.projectPath]) {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

test('real Electron rejects the unguarded request, exactly as it did when this broke', async () => {
  // A Vue reactive array IS a Proxy, and structuredClone refuses one. This is the
  // literal bug reproduced through the real preload bridge. If this ever stops
  // throwing, the test below has become meaningless and must be revisited.
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
  // The renamed suite proves this is the fixed bundle, not a stale build.
  await expect(page.getByTestId('tests-suite-dotnet-http')).toContainText('real endpoints')

  // ...and none of the Blazor ones. This project routes controllers and has no
  // components, so driving screens in a browser would prove nothing about it —
  // the narrowing is what keeps them off the list.
  await expect(page.getByTestId('tests-suite-blazor-ui')).toHaveCount(0)
  await expect(page.getByTestId('tests-suite-blazor-interactive')).toHaveCount(0)
  // The header names what is actually being verified, not everything .NET can be.
  await expect(page.getByTestId('tests-view')).toContainText('.NET API')
})

// Runs before the Run verification test on purpose: that test starts a new run,
// which then becomes the latest and hides the seeded finished one.
test('the real application renders endpoint results with the row behind each call', async () => {
  await page.getByTestId('sidebar-project-sample-api').click()
  await page.getByTestId('tab-tests').click()
  await page.getByTestId('tests-sub-evidence').click()

  // A passing call, checked back against the row its id came from.
  const passing = page.getByTestId('tests-endpoint-0')
  await expect(passing).toContainText('GET')
  await expect(passing).toContainText('/api/v1/policies/PL-88213')
  await expect(passing).toContainText('200')
  await expect(passing).toContainText('96 ms')
  await expect(passing).toContainText('postgres-reporting')
  await expect(passing).toContainText("select id from policies where status = 'Active'")
  await expect(passing).toContainText('the row lists 3 contracts; the response listed 3')

  // The failure only a real call finds: 200 with an empty body for a missing id.
  // A suite run against fixtures would have called this green.
  const wrong = page.getByTestId('tests-endpoint-1')
  await expect(wrong).toContainText('fail')
  await expect(wrong).toContainText('200')
  await expect(wrong).toContainText('this must be a 404')

  // The write it correctly refused to make, with no status invented for it.
  const refused = page.getByTestId('tests-endpoint-2')
  await expect(refused).toContainText('not run')
  await expect(refused).toContainText('does not point at a test database')
  await expect(refused).toContainText('—')

  // And the section is headed as what it is, in the shipped bundle.
  await expect(page.getByTestId('tests-panel-evidence')).toContainText('REAL ENDPOINTS, REAL DATA')

  if (process.env.REAL_APP_SHOT) {
    // Scrolled to the endpoints and viewport-only: a fullPage shot of an app with
    // its own internal scroller composites the fixed composer over the content and
    // invents an overlap that is not on screen.
    await page.getByTestId('tests-endpoint-2').scrollIntoViewIfNeeded()
    await page.screenshot({ path: process.env.REAL_APP_SHOT })
  }
  // Integration is a real gate reading these suites, so it must reflect the failure.
  await expect(page.getByTestId('tests-gate-integration')).toContainText('failed')
})

test('Run verification crosses the real boundary without the clone error', async () => {
  await page.getByTestId('sidebar-project-sample-api').click()
  await page.getByTestId('tab-tests').click()
  // Mutation testing is heavy, so it starts unticked. Tick it to reach the exact
  // state the report came from: all seven suites selected.
  await page.getByTestId('tests-suite-dotnet-mutation').click()
  await expect(page.getByTestId('tests-suite-count')).toContainText('7 of 7')

  await page.getByTestId('tests-run').click()

  // What comes back must be the handler's own complaint about the missing CLI.
  // That is positive proof of the whole path: the request was serialised by real
  // structuredClone, crossed the real contextBridge, was validated against the
  // stack and the suite plan, and reached the session lookup — none of which is
  // reachable if the clone fails, because the clone happens first.
  const banner = page.getByTestId('tests-error')
  await expect(banner).toBeVisible()
  const message = (await banner.textContent()) ?? ''
  expect(message).not.toMatch(/could not be cloned/i)
  expect(message).toMatch(/Claude Code was not found/i)
})

// Last in the file on purpose: creating groups changes the sidebar's shape, and
// every test above it addresses projects by row.
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

  // On screen is not the same claim as persisted: read the real store back.
  const names = await page.evaluate(async () => {
    const settings = await window.switchboard.invoke('settings.get', undefined)
    return settings.projectGroups.map((group) => group.name)
  })
  expect(names).toEqual(['Work', 'Clients'])
})

// The two flows behind "I cannot create multiple groups", both reproduced
// against the real store before they were fixed.
//
// Every group edit is read-modify-write on ONE whole-array setting, read only
// once the IPC round trip returns. A second edit starting while the first was
// still in flight rebuilt from a copy missing the first edit, so the last write
// won — compounded by every new group being called "New group", making a second
// one indistinguishable even when it did persist.
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
  // No Enter: clicking the button blurs the name field, so the rename and the
  // create are in flight together. This lost the name every time.
  await page.getByTestId('new-group').click()
  await page.getByTestId('group-rename-input-New group').fill('Work')
  await page.getByTestId('new-group').click()

  await expect(page.getByTestId('group-head-Work')).toBeVisible()
  expect(await groupNames()).toEqual(['Work', 'New group'])
})

test('two group creations in the same tick both survive, distinctly named', async () => {
  await clearGroups()
  // Dispatched together, so neither create sees the other's round trip. A button
  // a user can double-click must not silently collapse two groups into one.
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="new-group"]') as HTMLButtonElement
    button.click()
    button.click()
  })

  await expect(page.getByTestId('group-head-New group 2')).toBeVisible()
  expect(await groupNames()).toEqual(['New group', 'New group 2'])
})

// The UI is served from its own scheme rather than file://, so that "'self'" in
// the policy names one real, bounded origin. Every other test above only proves
// the app renders; these two say WHERE it renders from and that the policy is
// actually live there — the pair that would catch the protocol handler being
// dropped or the CSP quietly ceasing to apply to it.
test('the UI runs on its own origin, not file://', async () => {
  const origin = await page.evaluate(() => window.location.origin)
  expect(origin).toBe('app://bundle')
})

test('the content security policy is live on that origin', async () => {
  // An inline <script> appended to the document, which is what script-src 'self'
  // exists to stop. Deliberately NOT an eval() check: page.evaluate runs through
  // the debugger protocol, which is not subject to the page's policy, so an eval
  // test passes whether or not a CSP is present and proves nothing. A real
  // element in the real document is governed by the real policy.
  const escaped = await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__cspEscaped = true'
    document.head.appendChild(script)
    script.remove()
    return (window as unknown as { __cspEscaped?: boolean }).__cspEscaped === true
  })
  expect(escaped).toBe(false)
})
