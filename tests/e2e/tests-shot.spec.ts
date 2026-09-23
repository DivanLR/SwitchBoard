import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.skip(!process.env.SHOTS, 'screenshot pass; set SHOTS=1 to capture')

test('the tests section on a wide window, with a grey suite ticked', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-tests').click()
  await page.getByTestId('tests-stack-dotnet').click()

  await page.getByTestId('tests-run').click()
  await expect(page.getByTestId('tests-run')).toContainText('Running')
  await page.evaluate(() =>
    window.__mock.reportVerifyResult('p-alpha', 'fail', {
      suites: [
        { id: 'dotnet-unit', label: 'Unit tests', status: 'pass', detail: '142 passed' },
        { id: 'dotnet-http', label: 'HTTP smoke', status: 'not_run', detail: 'no test database' },
        { id: 'dotnet-arch', label: 'Architecture rules', status: 'fail', detail: '2 failed' },
      ],
      coverage: {
        line: { value: 81.4, source: 'vitest --coverage' },
        changed: { value: 93, source: 'coverage vs git diff' },
        files: [],
      },
      quality: {
        gate: null,
        gateSource: null,
        duplication: { value: null, source: null },
        mutation: { value: null, source: null },
        mutationKilled: null,
        mutationSurvived: null,
        archViolations: { value: null, source: null },
        debt: null,
        findings: [],
      },
      evidence: [],
      endpoints: [],
    }),
  )

  await expect(page.getByTestId('tests-suite-dotnet-http')).toHaveClass(/ran-not_run/)
  await page.screenshot({ path: '.impeccable/shots/tests-wide.png' })
  await page.getByTestId('tests-gates').screenshot({ path: '.impeccable/shots/tests-gates.png' })
  await page.getByTestId('tests-suites').screenshot({ path: '.impeccable/shots/tests-suites.png' })

  await page.getByTestId('tests-full-screen').click()
  await expect(page.getByTestId('tab-tests')).toHaveCount(0)
  await page.screenshot({ path: '.impeccable/shots/tests-fullscreen.png' })
})
