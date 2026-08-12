// Design screenshots. Not a test: it drives the mock host to a full board and
// writes PNGs for a visual review pass. Skipped unless SHOTS=1, so `npm run
// check` never pays for it.
//
// Run: SHOTS=1 npx playwright test tests/e2e/shots.spec.ts
// Output: .impeccable/shots/<name>.png
import { test } from '@playwright/test'
import { installMockHost, type MockScenario } from './mock-host'
import { DEFAULT_SETTINGS } from '../../src/shared/domain'
import { detectStacks } from '../../src/shared/test-catalog'

test.skip(!process.env.SHOTS, 'design screenshots; set SHOTS=1 to capture')

const OUT = '.impeccable/shots'

function boardScenario(): MockScenario {
  return {
    settings: DEFAULT_SETTINGS,
    suites: detectStacks(['package.json']),
    projects: [
      {
        id: 'p-storefront',
        name: 'storefront',
        path: 'C:\\work\\storefront',
        session: {
          id: 's-storefront',
          status: 'working',
          branch: 'fix/cart-race',
          mcpServers: [
            { name: 'postgres — production', status: 'connected' },
            { name: 'github', status: 'connected' },
            { name: 'playwright', status: 'connected' },
          ],
        },
      },
      {
        id: 'p-api',
        name: 'api-server',
        path: 'C:\\work\\api-server',
        session: { id: 's-api', status: 'needs_you', branch: 'feat/auth-refresh' },
      },
      {
        id: 'p-ml',
        name: 'ml-pipeline',
        path: 'C:\\work\\ml-pipeline',
        session: { id: 's-ml', status: 'needs_you', branch: 'main' },
      },
      {
        id: 'p-mobile',
        name: 'mobile-app',
        path: 'C:\\work\\mobile-app',
        session: { id: 's-mobile', status: 'done', branch: 'release/2.4' },
      },
      {
        id: 'p-infra',
        name: 'infra',
        path: 'C:\\work\\infra',
        session: { id: 's-infra', status: 'error', branch: 'main' },
      },
      { id: 'p-docs', name: 'docs-site', path: 'C:\\work\\docs-site' },
    ],
  }
}

async function seedBoard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(installMockHost, boardScenario())
  await page.goto('/')
  await page.getByTestId('sidebar-project-storefront').waitFor()

  await page.evaluate(() => {
    const m = window.__mock
    m.emitEvent('s-storefront', 'prompt', {
      text: 'Cart shows stale totals when two items are added fast. Fix the race.',
    })
    m.emitEvent('s-storefront', 'summary', {
      text: 'Reproduced it: two optimistic updates race and the second server response overwrites the first. Plan: version the cart state and reconcile responses by version.',
    })
    m.emitEvent('s-storefront', 'tool_activity', {
      toolName: 'Read',
      inputPreview: 'src/hooks/useCart.ts',
    })
    m.emitEvent('s-storefront', 'tool_activity', {
      toolName: 'Bash',
      inputPreview: 'npm test -- cart',
    })
    m.emitEvent('s-storefront', 'assistant_text', {
      text: 'The reconciliation now keys off a monotonic `version` field, so a late response cannot overwrite a newer local state.\n\n- `useCart.ts` versions every optimistic update\n- `cartReducer.ts` drops responses older than the state it holds\n- one regression test covers the two-add race\n\nRun `npm test -- cart` to confirm.',
      partial: false,
    })
    m.emitEvent('s-infra', 'error', {
      text: 'terraform plan failed: provider aws requires credentials',
      fatal: false,
    })

    m.raisePermission({
      projectId: 'p-storefront',
      toolName: 'Edit',
      title: 'Edit the cart state hook',
      explanation:
        'Rewrites the optimistic update in useCart to version cart state. This is the actual race fix.',
      detail: 'src/hooks/useCart.ts (+41 -18)',
      risk: 'low',
    })
    m.raisePermission({
      projectId: 'p-storefront',
      toolName: 'Bash',
      title: 'Run the cart test suite',
      explanation: 'Verifies the race fix against the existing cart integration tests.',
      detail: 'npm test -- cart',
      risk: 'medium',
    })
    m.raisePermission({
      projectId: 'p-ml',
      toolName: 'Bash',
      title: 'Delete cached datasets',
      explanation:
        'Clears 4.2 GB of stale feature caches (118 files). Everything is regenerable, but re-extraction takes about 40 minutes.',
      detail: 'rm -rf data/cache/*',
      risk: 'high',
    })
    m.setUsage('s-storefront', 0.75, 119, 'five_hour')
  })

  await page.waitForTimeout(400)
}

for (const [label, size] of [
  ['wide', { width: 1600, height: 1000 }],
  ['min', { width: 1080, height: 620 }],
] as const) {
  test(`board ${label}`, async ({ page }) => {
    await page.setViewportSize(size)
    await seedBoard(page)
    await page.screenshot({ path: `${OUT}/board-${label}.png` })
  })
}

// The Diff tab with a change set big enough for the folder grouping to be the point.
test('diff folders', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.addInitScript(installMockHost, {
    ...boardScenario(),
    projects: boardScenario().projects.map((p, i) =>
      i === 0
        ? {
            ...p,
            diff: {
              gitNotice: null,
              files: [
                { path: 'package.json', status: 'modified', addedLines: 2, removedLines: 2, binary: false },
                { path: 'src/hooks/useCart.ts', status: 'modified', addedLines: 41, removedLines: 18, binary: false },
                { path: 'src/hooks/useCheckout.ts', status: 'modified', addedLines: 6, removedLines: 3, binary: false },
                { path: 'src/state/cartReducer.ts', status: 'modified', addedLines: 22, removedLines: 9, binary: false },
                { path: 'src/state/version.ts', status: 'added', addedLines: 14, removedLines: 0, binary: false },
                { path: 'tests/cart.spec.ts', status: 'added', addedLines: 58, removedLines: 0, binary: false },
                { path: 'docs/architecture.png', status: 'modified', addedLines: null, removedLines: null, binary: true },
              ],
            },
          }
        : p,
    ),
  })
  await page.goto('/')
  await page.getByTestId('sidebar-project-storefront').click()
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('diff-file-list').waitFor()
  await page.getByTestId('diff-file-src/hooks/useCart.ts').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/diff-folders.png` })
})

// A project running more than one session, so the nested subsession rows are visible.
// Started through the context menu rather than seeded, because the scenario seed still
// describes one session per project.
test('subsessions', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await seedBoard(page)
  await page.getByTestId('sidebar-project-storefront').click({ button: 'right' })
  await page.getByTestId('ctx-new-session').click()
  await page.getByTestId('sidebar-subsessions-storefront').waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/board-subsessions.png` })
})

test('light theme', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await seedBoard(page)
  await page.evaluate(() => document.documentElement.classList.add('sb-light'))
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/board-light.png` })
})

// The start controls: one mode picker carrying every mode the SDK has, one
// Resume switch, one Start button. Captured open, because the list is where the
// descriptions live and a closed picker shows none of them.
test('session start', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await seedBoard(page)
  await page.getByTestId('sidebar-project-storefront').click()
  await page.getByTestId('end-session').click()
  await page.getByTestId('ended-banner').waitFor()
  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-list').waitFor()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/session-start.png` })
})

test('tests section', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await seedBoard(page)
  await page.getByTestId('sidebar-project-storefront').click()
  await page.getByTestId('tab-tests').click()
  await page.getByTestId('tests-view').waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/tests-section.png` })
})

test('settings', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await seedBoard(page)
  await page.getByTestId('open-settings').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/settings.png` })
})

// The scrim and the dialogue tier are the one place the two themes dim
// differently, so paper gets its own capture rather than being read off the dark one.
test('settings light', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await seedBoard(page)
  await page.evaluate(() => document.documentElement.classList.add('sb-light'))
  await page.getByTestId('open-settings').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/settings-light.png` })
})
