// The real application: real main process, real CommonJS preload, real
// contextBridge, real production renderer bundle. No mock host.
//
// This exists for one reason. The Tests section's Run verification button failed
// with "An object could not be cloned", and every other test in this suite runs
// against a mock `window.switchboard`. A mock can be made to accept a request the
// real contextBridge rejects, so only the real stack can prove the fix. The two
// assertions here are deliberately paired: that real Electron genuinely rejects
// the unguarded shape (so the bug was real and the guard is not superstition),
// and that the button's own path now crosses the same boundary intact.
//
// It runs against out/, so `npm run build` must have happened. Its own config
// (playwright.real.config.ts) keeps it out of the renderer-only suite, which has
// a dev-server webServer this test neither needs nor wants.
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
      //
      // This matters more than it looks. reconcileOnStartup marks every session
      // row ended before the window paints, so the seeded session is NOT reused:
      // clicking Run verification would spawn a real Claude Code session, spend
      // real tokens, and leave it running against a temp directory. With no CLI
      // resolvable, startSession fails fast with its install message instead —
      // which is exactly the discriminator this suite needs, since a complaint
      // about the CLI can only be reached after the request has crossed the
      // bridge and run through the real handler.
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
