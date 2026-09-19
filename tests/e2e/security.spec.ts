import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'

const AUDIT_SKILL = {
  name: 'security-audit',
  description: 'Turns the agent into a security auditor.',
  sourceUrl: 'https://github.com/cloudflare/security-audit-skill',
  sourcePath: 'skills/security-audit',
  enabled: true,
  fileCount: 21,
  importedAt: '2026-09-16T09:00:00.000Z',
}

const REPORT = {
  units: [
    { coverageId: 'ipc:handlers:injection', attackClass: 'injection', subsystem: 'ipc', status: 'covered' },
    { coverageId: 'ipc:handlers:traversal', attackClass: 'path-traversal', subsystem: 'ipc', status: 'candidate' },
    { coverageId: 'native:memory', attackClass: 'memory-safety', subsystem: 'native', status: 'not_applicable' },
  ],
  findings: [
    {
      fingerprint: 'fp-1',
      verdict: 'confirmed',
      title: 'Path escapes the project root',
      severity: 'high',
      attackClass: 'path-traversal',
      file: 'src/main/skills/import.ts',
      line: 118,
    },
    {
      fingerprint: 'fp-2',
      verdict: 'rejected',
      title: 'Renderer can reach Node',
      severity: null,
      attackClass: null,
      file: null,
      line: null,
    },
  ],
  artefacts: ['REPORT.md'],
}

function scenarioWith(skills: MockScenario['skills']): MockScenario {
  return { ...twoProjectScenario(), skills }
}

async function openSecurity(page: Page, skills: MockScenario['skills']): Promise<void> {
  await page.addInitScript(installMockHost, scenarioWith(skills))
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('tab-security').click()
  await expect(page.getByTestId('security-view')).toBeVisible()
}

test('without the skill the tab offers to install it, and will not run', async ({ page }) => {
  await openSecurity(page, [])

  await expect(page.getByTestId('security-install')).toBeVisible()
  await expect(page.getByTestId('security-run')).toBeDisabled()

  await page.evaluate((skill) => window.__mock.setSkillImport([skill]), AUDIT_SKILL)
  await page.getByTestId('security-install-btn').click()

  await expect(page.getByTestId('security-install')).toHaveCount(0)
  await expect(page.getByTestId('security-run')).toBeEnabled()
})

test('a run is dispatched with the scope that was picked, and only one runs at a time', async ({
  page,
}) => {
  await openSecurity(page, [AUDIT_SKILL])
  await expect(page.getByTestId('security-empty')).toBeVisible()

  await page.getByTestId('security-scope-changes').click()
  await page.getByTestId('security-run').click()

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toContain('Scope: changes')
  await expect(page.getByTestId('security-running')).toContainText('pending changes')
  await expect(page.getByTestId('security-stop')).toBeVisible()
  await expect(page.getByTestId('security-run')).toHaveCount(0)
})

test('a finished audit is drawn as percentages, bars and findings', async ({ page }) => {
  await openSecurity(page, [AUDIT_SKILL])
  await page.getByTestId('security-run').click()
  await expect(page.getByTestId('security-running')).toBeVisible()

  await page.evaluate(
    (report) => window.__mock.reportSecurityResult('p-alpha', 'complete', report),
    REPORT,
  )

  await expect(page.getByTestId('security-coverage')).toHaveText('50%')
  await expect(page.getByTestId('security-confirmed')).toHaveText('1')
  await expect(page.getByTestId('security-disproved')).toHaveText('50%')
  await expect(page.getByTestId('security-clean')).toHaveText('50%')

  await expect(page.getByTestId('security-severity')).toContainText('high')
  await expect(page.getByTestId('security-classes')).toContainText('path-traversal')
  await expect(page.getByTestId('security-findings')).toContainText('Path escapes the project root')
  await expect(page.getByTestId('security-findings')).toContainText('src/main/skills/import.ts:118')
  await expect(page.getByTestId('security-findings')).not.toContainText('Renderer can reach Node')

  await page.getByTestId('security-artefact-REPORT.md').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().reportOpens)).at(-1)?.file)
    .toBe('REPORT.md')
})

test('stopping a run says so rather than leaving it open forever', async ({ page }) => {
  await openSecurity(page, [AUDIT_SKILL])
  await page.getByTestId('security-run').click()
  await page.getByTestId('security-stop').click()

  await expect(page.getByTestId('security-run')).toBeEnabled()
  await expect(page.getByTestId('security-no-report')).toContainText('You stopped this run')
})
