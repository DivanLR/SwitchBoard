// T028: central inbox flow against the mock host (quickstart V1). The inbox is
// a permanent right-hand panel in the Switchboard design, so no toggle is
// needed to reach it.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('requests from two projects land in one inbox, grouped, with risk and explanation', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Run: git status',
      explanation: 'The session wants to run a shell command.',
      risk: 'low',
    })
    window.__mock.raisePermission({
      projectId: 'p-beta',
      title: 'Write config.json',
      explanation: 'The session wants to modify a file.',
      risk: 'medium',
    })
  })

  // Both sessions show needs-you dots and the inbox badge updates (FR-013).
  await expect(page.getByTestId('status-badge-alpha')).toHaveAttribute('data-status', 'needs_you')
  await expect(page.getByTestId('status-badge-beta')).toHaveAttribute('data-status', 'needs_you')
  await expect(page.getByTestId('inbox-badge')).toHaveText('2')

  await expect(page.getByTestId('inbox-group-alpha')).toBeVisible()
  await expect(page.getByTestId('inbox-group-beta')).toBeVisible()
  const alphaItem = page.getByTestId('inbox-group-alpha').getByTestId('inbox-item')
  await expect(alphaItem).toContainText('Run: git status')
  await expect(alphaItem).toContainText('The session wants to run a shell command.')
  await expect(alphaItem.locator('.chip-risk')).toHaveText('Low')
  await expect(alphaItem).toContainText(/\d+[smh] ago/)
})

test('approve and deny round-trip to the sessions and land in history', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'Run: npm test', risk: 'medium' })
    window.__mock.raisePermission({ projectId: 'p-beta', title: 'Run: npm build', risk: 'medium' })
  })

  await page.getByTestId('inbox-group-alpha').getByTestId('approve-btn').click()
  await page.getByTestId('inbox-group-beta').getByTestId('deny-btn').click()
  await expect(page.getByTestId('inbox-zero')).toBeVisible()

  const decisions = await page.evaluate(() => window.__mock.state().decisions)
  expect(decisions).toEqual([
    { requestId: expect.any(String), decision: 'approve' },
    { requestId: expect.any(String), decision: 'deny' },
  ])

  await page.getByTestId('inbox-tab-history').click()
  await expect(page.getByTestId('outcome-approved')).toBeVisible()
  await expect(page.getByTestId('outcome-denied')).toBeVisible()
})

test('high-risk approval requires the explicit confirm step (FR-010)', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'Run: rm -rf dist', risk: 'high' })
  })

  await page.getByTestId('approve-btn').click()
  // Still pending: the first click only reveals the confirmation.
  await expect(page.getByTestId('confirm-high-risk')).toBeVisible()
  expect(await page.evaluate(() => window.__mock.state().decisions)).toHaveLength(0)

  await page.getByTestId('confirm-high-risk').click()
  await expect(page.getByTestId('inbox-zero')).toBeVisible()
  expect(await page.evaluate(() => window.__mock.state().decisions)).toEqual([
    { requestId: expect.any(String), decision: 'approve' },
  ])
})

test('approve-all approves the group but skips high-risk items (FR-011)', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'low one', risk: 'low' })
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'medium one', risk: 'medium' })
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'high one', risk: 'high' })
    window.__mock.raisePermission({ projectId: 'p-beta', title: 'other group', risk: 'low' })
  })

  // No toast appears while the window is focused, so the group controls are clear.
  await page.getByTestId('inbox-group-alpha').getByTestId('approve-all').click()

  // The high-risk item stays, as does the other project's group.
  const remaining = page.getByTestId('inbox-item')
  await expect(remaining).toHaveCount(2)
  await expect(page.getByTestId('inbox-group-alpha')).toContainText('high one')
  await expect(page.getByTestId('inbox-group-beta')).toContainText('other group')
})

test('plan approvals carry the plan badge and approve with a single click (FR-007a)', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Plan approval',
      detail: '1. Refactor\n2. Test',
      type: 'plan_approval',
      risk: 'low',
    })
  })
  await expect(page.getByTestId('inbox-item').locator('.chip-risk.plan')).toHaveText('Plan')
  await page.getByTestId('approve-btn').click()
  await expect(page.getByTestId('inbox-zero')).toBeVisible()
})

test('history rows expand via an arrow to show the full description', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Run: npm run build',
      explanation: 'Builds the production bundle to verify the change compiles.',
      detail: 'Bash: npm run build',
      risk: 'low',
    })
  })
  await page.getByTestId('inbox-group-alpha').getByTestId('approve-btn').click()
  await page.getByTestId('inbox-tab-history').click()

  const row = page.getByTestId('history-item').first()
  await expect(row).toContainText('Run: npm run build')
  // Detail hidden until expanded.
  await expect(page.getByTestId('history-detail')).toHaveCount(0)
  await row.click()
  await expect(page.getByTestId('history-detail')).toContainText(
    'Builds the production bundle to verify the change compiles.',
  )
})

test('right-click a history command offers always-allow with the flag-aware base', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Run: npx prisma migrate dev',
      detail: 'npx prisma migrate dev --name rotation',
      risk: 'medium',
    })
  })
  await page.getByTestId('approve-btn').click()
  await page.getByTestId('inbox-tab-history').click()
  await page.getByTestId('history-item').first().click({ button: 'right' })

  const menu = page.getByTestId('hist-ctx-menu')
  await expect(menu).toContainText('npx prisma migrate dev --name rotation')
  await expect(menu.getByTestId('hist-ctx-allow')).toContainText('Always allow npx prisma commands')
  await menu.getByTestId('hist-ctx-allow').click()
  await expect(menu).toHaveCount(0)

  const rules = await page.evaluate(() =>
    window.switchboard.invoke('rules.standing.list', { projectId: 'p-alpha' }),
  )
  expect(rules).toContainEqual(
    expect.objectContaining({ matcher: { kind: 'command_prefix', value: 'npx prisma' } }),
  )
})

test('history right-click: destructive command gets no allow item; entries remove and clear', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'Run: ls', detail: 'ls -la', risk: 'low' })
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'Run: rm', detail: 'rm -rf dist', risk: 'high' })
  })
  await page.getByTestId('inbox-item').filter({ hasText: 'Run: ls' }).getByTestId('approve-btn').click()
  await page.getByTestId('inbox-item').filter({ hasText: 'Run: rm' }).getByTestId('deny-btn').click()

  await page.getByTestId('inbox-tab-history').click()
  await expect(page.getByTestId('history-count')).toHaveText('DECISIONS · 2')

  // Destructive entry (rm): menu opens, but there is no always-allow item.
  await page.getByTestId('history-item').filter({ hasText: 'Run: rm' }).click({ button: 'right' })
  await expect(page.getByTestId('hist-ctx-menu')).toBeVisible()
  await expect(page.getByTestId('hist-ctx-allow')).toHaveCount(0)

  // Remove just that entry.
  await page.getByTestId('hist-ctx-remove').click()
  await expect(page.getByTestId('history-item')).toHaveCount(1)
  await expect(page.getByTestId('history-count')).toHaveText('DECISIONS · 1')

  // A flag as word two narrows the base to a single word.
  await page.getByTestId('history-item').first().click({ button: 'right' })
  await expect(page.getByTestId('hist-ctx-allow')).toContainText('Always allow ls commands')
  await page.mouse.click(10, 10) // overlay click closes the menu
  await expect(page.getByTestId('hist-ctx-menu')).toHaveCount(0)

  // Clear the rest.
  await page.getByTestId('history-clear').click()
  await expect(page.getByTestId('history-item')).toHaveCount(0)
  await expect(page.getByTestId('history-count')).toHaveText('DECISIONS · 0')
})

test('inbox zero state communicates nothing needs attention', async ({ page }) => {
  await expect(page.getByTestId('inbox-zero')).toContainText('Inbox zero')
})
