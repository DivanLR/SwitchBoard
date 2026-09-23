import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

const SPEC_DETAIL = {
  id: '001-cart',
  title: 'Cart race fix',
  status: 'in_progress',
  tasksTotal: 3,
  tasksDone: 1,
  description: 'Stop two tabs emptying the same cart.',
  path: 'specs/001-cart',
  sections: [{ title: 'Summary', body: 'Stop two tabs emptying the same cart.' }],
  plan: [{ title: 'Approach', body: 'A row version on the cart.' }],
  phases: [
    {
      label: 'Phase 1: Build',
      tasks: [
        { id: 'T001', label: 'Add the row version', done: true },
        { id: 'T002', label: 'Retry on conflict', done: false },
      ],
    },
    { label: 'Phase 2: Convergence', tasks: [{ id: 'T003', label: 'Cover the retry', done: false }] },
  ],
  clarifications: ['How many retries?'],
  resolvedClarifications: [{ question: 'Which store?', answer: 'SQL Server' }],
  convergence: { rounds: 1, open: 1 },
}

async function openSdd(page: Page, kit: Record<string, unknown> | null): Promise<void> {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  if (kit) await page.evaluate((state) => window.__mock.setSpecKit('p-alpha', state), kit)
  await page.getByTestId('tab-sdd').click()
  await expect(page.getByTestId('sdd-view')).toBeVisible()
}

async function sends(page: Page): Promise<string[]> {
  return (await page.evaluate(() => window.__mock.state().sends)).map((s) => s.text)
}

const INSTALLED = {
  installed: true,
  constitution: 'written',
  specs: [{ id: '001-cart', title: 'Cart race fix', status: 'in_progress', tasksTotal: 3, tasksDone: 1 }],
  details: { '001-cart': SPEC_DETAIL },
}

test('the SDD tab offers to set Spec Kit up, then shows the three processes', async ({ page }) => {
  await openSdd(page, null)
  await expect(page.getByTestId('specs-not-installed')).toBeVisible()
  await page.getByTestId('specs-install').click()
  await expect(page.getByTestId('sdd-section-features')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('sdd-section-bugs')).toBeVisible()
  await expect(page.getByTestId('sdd-section-ideas')).toBeVisible()
  await expect(page.getByTestId('specs-empty')).toBeVisible()
})

test('a missing or template constitution offers Write the constitution, in a fresh session', async ({ page }) => {
  await openSdd(page, { ...INSTALLED, constitution: 'template' })
  await expect(page.getByTestId('sdd-constitution')).toHaveText('The constitution is still the template')
  await page.getByTestId('sdd-constitution-write').click()
  await expect(page.getByTestId('sdd-run-speckit-constitution')).toBeVisible()
  expect(await sends(page)).toContain('/speckit-constitution')
})

test('a written constitution needs no action', async ({ page }) => {
  await openSdd(page, INSTALLED)
  await expect(page.getByTestId('sdd-constitution')).toHaveText('Constitution written')
  await expect(page.getByTestId('sdd-constitution-write')).toHaveCount(0)
})

test('a feature shows its spec, plan, tasks progress, clarifications and converge state', async ({ page }) => {
  await openSdd(page, INSTALLED)
  await expect(page.getByTestId('spec-chip-001-cart')).toHaveClass(/is-on/)
  await expect(page.getByTestId('spec-progress')).toHaveText('1/3 tasks')
  await expect(page.getByTestId('spec-converge')).toHaveText('1 convergence round, 1 task open')
  await expect(page.getByTestId('task-done')).toHaveCount(1)
  await expect(page.getByTestId('task-todo')).toHaveCount(2)
  await page.getByTestId('part-plan').click()
  await expect(page.getByTestId('spec-sections')).toContainText('A row version on the cart.')
  await page.getByTestId('part-clarify').click()
  await expect(page.getByTestId('spec-clarify')).toContainText('How many retries?')
  await expect(page.getByTestId('resolved-clarification')).toContainText('SQL Server')
})

test('answering a clarification targets the composer and runs the edit in its own session', async ({ page }) => {
  await openSdd(page, INSTALLED)
  await page.getByTestId('part-clarify').click()
  await page.getByTestId('answer-Q1').click()
  await expect(page.getByTestId('composer-target')).toContainText('001-cart/clarify · Q1')
  await page.getByTestId('composer-input').fill('Three retries, then fail loudly')
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('composer-target')).toHaveCount(0)
  await expect.poll(() => sends(page)).toContain('✎ Spec edit → 001-cart/clarify · Q1: Three retries, then fail loudly')
})

test('every Spec Kit command is in the palette, and New spec asks for the description first', async ({ page }) => {
  await openSdd(page, INSTALLED)
  await page.getByTestId('part-commands').click()
  for (const command of ['constitution', 'specify', 'clarify', 'checklist', 'plan', 'tasks', 'analyze', 'implement', 'converge']) {
    await expect(page.getByTestId(`sdd-cmd-speckit-${command}`)).toBeVisible()
  }
  await page.getByTestId('sdd-cmd-speckit-converge').click()
  await expect.poll(() => sends(page)).toContain('/speckit-converge 001-cart')
  await expect(page.getByTestId('sdd-cmd-speckit-converge')).toBeDisabled()

  await page.getByTestId('spec-new').click()
  await expect(page.getByTestId('sdd-prompt')).toBeVisible()
  await expect(page.getByTestId('sdd-prompt-submit')).toBeDisabled()
  await page.getByTestId('sdd-prompt-input').fill('Guest checkout')
  await page.getByTestId('sdd-prompt-submit').click()
  await expect.poll(() => sends(page)).toContain('/speckit-specify "Guest checkout"')
})

test('a finished command session reloads the folders', async ({ page }) => {
  await openSdd(page, INSTALLED)
  await page.getByTestId('part-commands').click()
  await page.getByTestId('sdd-cmd-speckit-tasks').click()
  await expect(page.getByTestId('sdd-run-speckit-tasks')).toBeVisible()
  await page.evaluate((detail) => {
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      constitution: 'written',
      specs: [{ id: '001-cart', title: 'Cart race fix', status: 'complete', tasksTotal: 3, tasksDone: 3 }],
      details: { '001-cart': { ...detail, status: 'complete', tasksDone: 3 } },
    })
  }, SPEC_DETAIL)
  const sessionId = await page.evaluate(() => window.__mock.state().sends.at(-1)?.sessionId ?? '')
  await page.evaluate((id) => window.__mock.endSession(id), sessionId)
  await expect(page.getByTestId('sdd-run-speckit-tasks')).toHaveCount(0)
  await expect(page.getByTestId('spec-progress')).toHaveText('3/3 tasks')
})

test('Bugs offers to install the bug extension, reports a failure plainly, then lists each bug', async ({ page }) => {
  await openSdd(page, {
    ...INSTALLED,
    bugs: [
      {
        slug: 'login-timeout',
        title: 'Login times out',
        files: ['assessment.md', 'fix.md', 'test.md'],
        verdict: 'partial',
        severity: 'high',
      },
    ],
    reports: { 'bug/login-timeout/test.md': '# Verification\n\nThe timeout still happens behind the proxy.' },
  })
  await page.evaluate(() =>
    window.__mock.setExtensionInstallError(
      "specify extension add bug failed with exit code 1: Extension 'bug' is bundled with spec-kit but could not be found in the installed package.",
    ),
  )
  await page.getByTestId('sdd-section-bugs').click()
  await expect(page.getByTestId('sdd-missing-bug')).toBeVisible()
  await page.getByTestId('sdd-install-bug').click()
  await expect(page.getByTestId('sdd-install-error-bug')).toContainText('could not be found in the installed package')
  await page.evaluate(() => window.__mock.setExtensionInstallError(null))
  await page.getByTestId('sdd-install-bug').click()
  await expect(page.getByTestId('sdd-entry-login-timeout')).toBeVisible()
  await expect(page.getByTestId('sdd-entry-login-timeout')).toContainText('partial')
  await expect(page.getByTestId('sdd-verdict')).toHaveText('partial')
  await page.getByTestId('sdd-report-test.md').click()
  await expect(page.getByTestId('sdd-report-content')).toContainText('still happens behind the proxy')

  await page.getByTestId('sdd-cmd-speckit-bug-fix').click()
  await expect.poll(() => sends(page)).toContain('/speckit-bug-fix slug=login-timeout')

  await page.getByTestId('sdd-new-bug').click()
  await page.getByTestId('sdd-prompt-input').fill('Cart empties on refresh')
  await expect(page.getByTestId('sdd-prompt-slug')).toHaveValue('cart-empties-on-refresh')
  await page.getByTestId('sdd-prompt-submit').click()
  await expect.poll(() => sends(page)).toContain('/speckit-bug-assess "Cart empties on refresh" slug=cart-empties-on-refresh')
})

test('Ideas lists each assessment with its decision and runs the five assess commands', async ({ page }) => {
  await openSdd(page, {
    ...INSTALLED,
    extensions: { bug: true, assess: true },
    ideas: [{ slug: 'offline-mode', title: 'Offline mode', files: ['intake.md', 'decision.md'], verdict: 'go', severity: null }],
    reports: { 'assess/offline-mode/decision.md': '# Decision\n\n- **Verdict**: go\n' },
  })
  await page.getByTestId('sdd-section-ideas').click()
  await expect(page.getByTestId('sdd-entry-offline-mode')).toContainText('go')
  await expect(page.getByTestId('sdd-report-content')).toContainText('Verdict')
  for (const stage of ['intake', 'research', 'define', 'shape', 'decide']) {
    await expect(page.getByTestId(`sdd-cmd-speckit-assess-${stage}`)).toBeVisible()
  }
  await page.getByTestId('sdd-cmd-speckit-assess-shape').click()
  await expect.poll(() => sends(page)).toContain('/speckit-assess-shape slug=offline-mode')
})

test('Open in Flow starts the Flow intake on that spec', async ({ page }) => {
  await openSdd(page, INSTALLED)
  await page.getByTestId('sdd-open-flow').click()
  await expect(page.getByTestId('flow-popup')).toBeVisible()
  await expect(page.getByTestId('flow-source-spec')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('flow-existing-spec-001-cart')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('flow-start')).toBeEnabled()
})
