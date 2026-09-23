import { test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'
import { DEFAULT_SETTINGS } from '../../src/shared/domain'
import { detectStacks } from '../../src/shared/test-catalog'

test.skip(!process.env.SHOTS, 'design screenshots; set SHOTS=1 to capture')

const OUT = process.env.SHOTS_OUT ?? '.impeccable/shots/ui'
const TABS = ['session', 'tests', 'diff', 'diagrams'] as const

function scenario(): MockScenario {
  const base = twoProjectScenario()
  return {
    ...base,
    settings: DEFAULT_SETTINGS,
    suites: detectStacks(['package.json']),
    projects: base.projects.map((p, i) =>
      i === 0
        ? {
            ...p,
            diff: {
              gitNotice: null,
              files: [
                { path: 'package.json', status: 'modified', addedLines: 2, removedLines: 2, binary: false },
                { path: 'src/hooks/useCart.ts', status: 'modified', addedLines: 41, removedLines: 18, binary: false },
                { path: 'src/state/cartReducer.ts', status: 'modified', addedLines: 22, removedLines: 9, binary: false },
                { path: 'tests/cart.spec.ts', status: 'added', addedLines: 58, removedLines: 0, binary: false },
              ],
            },
          }
        : p,
    ),
  }
}

async function seed(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem('sb-theme', t), theme)
  await page.addInitScript(installMockHost, scenario())
  await page.goto('/')
  await page.getByTestId('sidebar-project-alpha').waitFor()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.evaluate(() => {
    const m = window.__mock
    m.emitEvent('s-alpha', 'prompt', { text: 'Cart shows stale totals when two items are added fast. Fix the race.' })
    m.emitEvent('s-alpha', 'summary', {
      text: 'Reproduced it: two optimistic updates race. Plan: version the cart state and reconcile responses by version.',
    })
    m.emitEvent('s-alpha', 'tool_activity', { toolName: 'Read', inputPreview: 'src/hooks/useCart.ts' })
    m.emitEvent('s-alpha', 'tool_activity', { toolName: 'Bash', inputPreview: 'npm test -- cart' })
    m.emitEvent('s-alpha', 'assistant_text', {
      text: 'The reconciliation now keys off a monotonic `version` field.\n\n- `useCart.ts` versions every optimistic update\n- one regression test covers the two-add race\n\nRun `npm test -- cart` to confirm.',
      partial: false,
    })
    m.raisePermission({
      projectId: 'p-alpha',
      toolName: 'Edit',
      title: 'Edit the cart state hook',
      explanation: 'Rewrites the optimistic update in useCart to version cart state.',
      detail: 'src/hooks/useCart.ts (+41 -18)',
      risk: 'low',
    })
    m.raisePermission({
      projectId: 'p-alpha',
      toolName: 'Bash',
      title: 'Delete cached datasets',
      explanation: 'Clears 4.2 GB of stale feature caches.',
      detail: 'rm -rf data/cache/*',
      risk: 'high',
    })
  })
  await page.waitForTimeout(400)
}

for (const theme of ['dark', 'light'] as const) {
  test(`all tabs ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await seed(page, theme)
    for (const tab of TABS) {
      await page.getByTestId(`tab-${tab}`).click()
      await page.waitForTimeout(350)
      await page.screenshot({ path: `${OUT}/${theme}-${tab}.png` })
    }
    await page.getByTestId('tab-session').click()
    await page.getByTestId('tab-terminal').click()
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${OUT}/${theme}-terminal.png` })
    await page.getByTestId('open-flow').click()
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${OUT}/${theme}-flow.png` })
    await page.keyboard.press('Escape')
    await page.getByTestId('open-settings').first().click()
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${OUT}/${theme}-settings.png` })
    await page.keyboard.press('Escape')
    await page.getByTestId('inbox-tab-history').click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${OUT}/${theme}-inbox-history.png` })
  })

  test(`empty project ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.addInitScript((t) => localStorage.setItem('sb-theme', t), theme)
    await page.addInitScript(installMockHost, scenario())
    await page.goto('/')
    await page.getByTestId('sidebar-project-beta').waitFor()
    await page.getByTestId('sidebar-project-beta').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${OUT}/${theme}-ended.png` })
    for (const tab of ['tests', 'diff'] as const) {
      await page.getByTestId(`tab-${tab}`).click()
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${OUT}/${theme}-empty-${tab}.png` })
    }
  })
}
