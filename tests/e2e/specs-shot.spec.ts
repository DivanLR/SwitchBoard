// Screenshot pass for the Specs section, opt-in like tests-shot.spec.ts. The
// stepper is the reason it exists: whether a sequence of phases READS as a
// sequence, and how the running/done/pending states sit against each other, are
// visual claims no assertion settles.
//
// Run with: SHOTS=1 npx playwright test tests/e2e/specs-shot.spec.ts
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.skip(!process.env.SHOTS, 'screenshot pass; set SHOTS=1 to capture')

test('the spec stepper across phases', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      specs: [
        { id: '001-architecture-world', title: 'Architecture World', status: 'in_progress', tasksTotal: 18, tasksDone: 7 },
      ],
      details: {
        '001-architecture-world': {
          id: '001-architecture-world',
          title: 'Architecture World, a 3D Repository Architecture Explorer',
          status: 'in_progress',
          tasksTotal: 18,
          tasksDone: 7,
          description:
            'A developer connects the application to their Azure DevOps organisation and explores every .NET repository as a world.',
          path: 'specs/001-architecture-world',
          sections: [{ title: 'Summary', body: 'A visual slice of the explorer.' }],
          plan: [{ title: 'Technical Context', body: 'Electron, Vue, three.js.' }],
          phases: [
            { label: 'Phase 1: Setup', tasks: [{ id: 'T001', label: 'scaffold', done: true }, { id: 'T002', label: 'tokens', done: true }] },
            { label: 'Phase 2: Scanner', tasks: [{ id: 'T003', label: 'ADO client', done: true }, { id: 'T004', label: 'repo filter', done: true }, { id: 'T005', label: 'cache', done: true }] },
            { label: 'Phase 3: Layout and world rendering that runs long', tasks: [{ id: 'T006', label: 'graph', done: true }, { id: 'T007', label: 'placement', done: true }, { id: 'T008', label: 'instancing', done: false }, { id: 'T009', label: 'labels', done: false }] },
            { label: 'Phase 4: Flight', tasks: [{ id: 'T010', label: 'camera', done: false }, { id: 'T011', label: 'collision', done: false }] },
            { label: 'Phase 5: Shell', tasks: [{ id: 'T012', label: 'panels', done: false }] },
            { label: 'Phase 6: Polish', tasks: [{ id: 'T013', label: 'motion', done: false }] },
          ],
          clarifications: [],
          resolvedClarifications: [],
        },
      },
    }),
  )
  await page.getByTestId('tab-specs').click()
  await expect(page.getByTestId('spec-stepper')).toBeVisible()
  await page.getByTestId('spec-stepper').screenshot({ path: 'test-results/spec-stepper.png' })
  await page.getByTestId('specs-view').screenshot({ path: 'test-results/spec-section.png' })
})

test('a command running, on the control that started it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      specs: [{ id: '001-x', title: 'X', status: 'draft', tasksTotal: 0, tasksDone: 0 }],
      details: {
        '001-x': {
          id: '001-x', title: 'X', status: 'draft', tasksTotal: 0, tasksDone: 0,
          description: 'desc', path: 'specs/001-x', sections: [], phases: [], clarifications: [], tasks: [],
        },
      },
    }),
  )
  await page.getByTestId('tab-specs').click()
  await page.getByTestId('part-cmds').click()
  // Held open so the waiting state can be photographed: a real start spends
  // this window spawning the CLI, or bringing a container image up.
  await page.evaluate(() => window.__mock.setStartDelay(4000))
  await page.getByTestId('speckit-cmd-speckit-plan').click()
  await expect(page.getByTestId('speckit-cmd-speckit-plan')).toContainText('Starting')
  await page.getByTestId('specs-view').screenshot({ path: 'test-results/spec-starting.png' })
  await expect(page.getByTestId('speckit-cmd-speckit-plan')).toContainText('Running', {
    timeout: 10_000,
  })
  await page.getByTestId('specs-view').screenshot({ path: 'test-results/spec-running.png' })
})
