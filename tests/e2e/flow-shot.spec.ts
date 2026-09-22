import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

const OUT = '.impeccable/shots'

const FEATURES = [
  { id: '4711', title: 'Checkout v2' },
  { id: '4712', title: 'Loyalty points' },
]

const ITEMS = [
  {
    localId: 'cart-race',
    title: 'Version the cart state',
    body: 'Reconcile optimistic updates by version so a late response cannot overwrite a newer local state.',
    acceptance: ['Two fast adds keep both items', 'The regression test covers the race'],
  },
  {
    localId: 'cart-tests',
    title: 'Cover the two-add race',
    body: 'One regression test at the reducer seam.',
    acceptance: ['npm test -- cart passes'],
  },
  {
    localId: 'cart-telemetry',
    title: 'Log reconciliation conflicts',
    body: 'Count how often a late response is dropped, so the fix can be measured in production.',
    acceptance: ['A counter appears in the existing metrics view'],
  },
]

test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })

test('flow tab shots', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sb-theme', 'dark'))
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await page.getByTestId('sidebar-project-alpha').waitFor()
  await page.getByTestId('open-flow').click()
  await expect(page.getByTestId('flow-popup')).toBeVisible()
  await page.evaluate((features) => window.__mock.setAdoFeatures(features), FEATURES)
  await page.getByTestId('flow-feature-refresh').click()
  await page.getByTestId('flow-feature-4711').waitFor()
  await page.screenshot({ path: `${OUT}/flow-pick.png` })

  await page.getByTestId('flow-feature-4711').click()
  await page.evaluate((items) => window.__mock.reportFlowScope('p-alpha', items), ITEMS)
  await page.getByTestId('flow-run-status').waitFor()
  await page.screenshot({ path: `${OUT}/flow-crosscheck.png` })

  await page.evaluate(() =>
    window.__mock.reportFlowSignoff('p-alpha', 'approve', [
      'the telemetry item leans on a metrics view that may not exist yet',
    ]),
  )
  await page.getByTestId('flow-items').waitFor()
  await page.screenshot({ path: `${OUT}/flow-approve.png` })

  await page.getByTestId('flow-publish').click()
  await page.getByTestId('flow-publish').click()
  await page.evaluate(() =>
    window.__mock.reportFlowPublished('p-alpha', [
      { localId: 'cart-race', workItemId: '5001' },
      { localId: 'cart-tests', workItemId: '5002' },
      { localId: 'cart-telemetry', workItemId: '5003' },
    ]),
  )
  await page.getByTestId('flow-start-work').click()
  await page.evaluate(() =>
    window.__mock.reportFlowItem('p-alpha', 'cart-race', 'pr_open', { prId: '312' }),
  )
  await page.evaluate(() =>
    window.__mock.reportFlowItem('p-alpha', 'cart-telemetry', 'blocked', {
      note: 'the metrics view the acceptance names does not exist in this repository',
    }),
  )
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/flow-working.png` })

  await page.getByTestId('flow-learn').click()
  await page.evaluate(() =>
    window.__mock.reportFlowLessons('p-alpha', [
      {
        rule: 'Name the work item in every commit message.',
        section: null,
        quote: 'which work item is this? I had to go and look.',
      },
      {
        rule: 'Put a regression test at the seam the bug crossed, not at the endpoint.',
        section: 'Testing',
        quote: 'this test would still pass with the bug in place',
      },
    ]),
  )
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/flow-lessons.png` })

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('flow-popup')).toHaveCount(0)
  await page.getByTestId('tab-security').click()
  await page.getByTestId('security-view').waitFor()
  await page.screenshot({ path: `${OUT}/flow-security.png` })
})
