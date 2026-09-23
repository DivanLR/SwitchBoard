import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'

const FOUND = [
  {
    name: 'code-review',
    description: 'Review a diff for correctness.',
    sourceUrl: '',
    sourcePath: 'skills/engineering/code-review',
    enabled: true,
    fileCount: 3,
    importedAt: '2026-08-21T09:00:00.000Z',
  },
  {
    name: 'write-tests',
    description: 'Write tests for the changed code.',
    sourceUrl: '',
    sourcePath: 'skills/engineering/write-tests',
    enabled: true,
    fileCount: 2,
    importedAt: '2026-08-21T09:00:00.000Z',
  },
]

function scenarioWith(skills: MockScenario['skills']): MockScenario {
  return { ...twoProjectScenario(), skills }
}

async function openSkillsTab(page: Page, scenario: MockScenario = twoProjectScenario()) {
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-skills').click()
  return panel
}

test('a GitHub folder becomes a list of skills, and only github.com is accepted', async ({
  page,
}) => {
  const panel = await openSkillsTab(page)
  await page.evaluate((found) => window.__mock.setSkillImport(found), FOUND)
  await expect(panel.getByTestId('skills-none')).toBeVisible()

  await panel.getByTestId('skills-url-input').fill('https://gitlab.com/owner/repo')
  await expect(panel.getByTestId('skills-url-problem')).toContainText('github.com')
  await expect(panel.getByTestId('skills-import-btn')).toBeDisabled()

  await panel
    .getByTestId('skills-url-input')
    .fill('https://github.com/mattpocock/skills/tree/main/skills/engineering')
  await expect(panel.getByTestId('skills-import-btn')).toBeEnabled()
  await panel.getByTestId('skills-import-btn').click()

  await expect(panel.getByTestId('skill-row-code-review')).toBeVisible()
  await expect(panel.getByTestId('skill-row-write-tests')).toBeVisible()
  await expect(panel.getByTestId('skill-toggle-code-review')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(panel.getByTestId('skill-group-mattpocock/skills')).toContainText('2/2 on')
  await expect(panel.getByTestId('skills-url-input')).toHaveValue('')
})

test('the pasted URL says what it names, before anything is requested', async ({ page }) => {
  const panel = await openSkillsTab(page)
  const reading = panel.getByTestId('skills-url-reading')

  await expect(reading).toHaveCount(0)
  await expect(panel.getByTestId('skills-url-problem')).toHaveCount(0)

  await panel
    .getByTestId('skills-url-input')
    .fill('https://github.com/mattpocock/skills/tree/main/skills/engineering')
  await expect(reading).toContainText('mattpocock/skills')
  await expect(reading).toContainText('main')
  await expect(reading).toContainText('skills/engineering')

  await panel.getByTestId('skills-url-input').fill('https://github.com/owner/repo')
  await expect(reading).toContainText('whole repository')
  await expect(reading).toContainText('default branch')
})

test('a URL that names no repository says which part is wrong', async ({ page }) => {
  const panel = await openSkillsTab(page)
  const input = panel.getByTestId('skills-url-input')
  const problem = panel.getByTestId('skills-url-problem')

  await input.fill('not a url at all')
  await expect(problem).toContainText('not a URL')

  await input.fill('https://github.com/owner')
  await expect(problem).toContainText('github.com/owner/repo')

  await input.fill('https://github.com/owner/repo/issues/4')
  await expect(problem).toContainText('/tree/')

  await expect(panel.getByTestId('skills-import-btn')).toBeDisabled()
})

test('imported skills are grouped by repository, and a whole source switches at once', async ({
  page,
}) => {
  const panel = await openSkillsTab(
    page,
    scenarioWith([
      ...FOUND.map((s) => ({ ...s, sourceUrl: 'https://github.com/mattpocock/skills' })),
      {
        ...FOUND[0],
        name: 'archify',
        sourceUrl: 'https://github.com/tt-a1i/archify/tree/main/archify',
      },
    ]),
  )

  const group = panel.getByTestId('skill-group-mattpocock/skills')
  await expect(group).toContainText('2/2 on')
  await expect(group.getByTestId('skill-row-archify')).toHaveCount(0)
  await expect(panel.getByTestId('skill-group-tt-a1i/archify')).toContainText('1/1 on')
  await expect(panel.getByTestId('skill-group-all-tt-a1i/archify')).toHaveCount(0)

  await panel.getByTestId('skill-group-all-mattpocock/skills').click()
  await expect(panel.getByTestId('skill-toggle-code-review')).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(panel.getByTestId('skill-toggle-write-tests')).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(group).toContainText('0/2 on')
  await expect(panel.getByTestId('skill-toggle-archify')).toHaveAttribute('aria-checked', 'true')

  await panel.getByTestId('skill-toggle-code-review').click()
  await expect(group).toContainText('1/2 on')
  await expect(panel.getByTestId('skill-group-all-mattpocock/skills')).toHaveText('all on')

  await panel.getByTestId('skill-group-all-mattpocock/skills').click()
  await expect(group).toContainText('2/2 on')
  await expect(panel.getByTestId('skill-group-all-mattpocock/skills')).toHaveText('all off')
})

test('one switch turns one skill off and on, and remove takes it out of the list', async ({
  page,
}) => {
  const panel = await openSkillsTab(
    page,
    scenarioWith(FOUND.map((s) => ({ ...s, sourceUrl: 'https://github.com/o/r' }))),
  )
  const toggle = panel.getByTestId('skill-toggle-write-tests')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(panel.getByTestId('skill-toggle-code-review')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await panel.getByTestId('skill-remove-write-tests').click()
  await expect(panel.getByTestId('skill-row-write-tests')).toHaveCount(0)
  await expect(panel.getByTestId('skill-row-code-review')).toBeVisible()
  await expect(panel.getByTestId('skill-group-o/r')).toContainText('1/1 on')

  await panel.getByTestId('skill-remove-code-review').click()
  await expect(panel.getByTestId('skills-none')).toBeVisible()
})

test('a skill of a name already switched on is skipped, and the skip says why', async ({
  page,
}) => {
  const panel = await openSkillsTab(
    page,
    scenarioWith([{ ...FOUND[0], sourceUrl: 'https://github.com/o/r' }]),
  )
  await page.evaluate((found) => window.__mock.setSkillImport(found), FOUND)

  await panel.getByTestId('skills-url-input').fill('https://github.com/o/r')
  await panel.getByTestId('skills-import-btn').click()

  await expect(panel.getByTestId('skill-row-write-tests')).toBeVisible()
  const skipped = panel.getByTestId('skills-skipped')
  await expect(skipped).toContainText('Skipped 1 of 2')
  await expect(skipped).toContainText('code-review')
  await expect(skipped).toContainText('already imported')
})

async function openSkillsSection(page: Page, scenario: MockScenario): Promise<void> {
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('tab-skills').click()
  await expect(page.getByTestId('skills-view')).toBeVisible()
}

const ON_SOURCE = FOUND.map((s) => ({ ...s, sourceUrl: 'https://github.com/o/r' }))

test('the Skills tab sits beside Session, Tests, Diff and Diagrams', async ({ page }) => {
  await openSkillsSection(page, scenarioWith(ON_SOURCE))
  const tabs = page.locator('.main-tabs .ui-tab')
  await expect(tabs).toHaveText(['Session', 'Tests', 'Diff', 'Diagrams', 'Skills'])
  await expect(page.getByTestId('tab-skills')).toHaveClass(/sel/)
})

test('a skill switched off in Settings leaves the section immediately', async ({ page }) => {
  await openSkillsSection(page, scenarioWith(ON_SOURCE))
  await expect(page.getByTestId('skill-run-code-review')).toBeVisible()
  await expect(page.getByTestId('skill-run-write-tests')).toBeVisible()

  await page.getByTestId('skills-manage').click()
  const panel = page.getByTestId('settings-panel')
  await expect(panel.getByTestId('skill-row-write-tests')).toBeVisible()
  await panel.getByTestId('skill-toggle-write-tests').click()
  await expect(panel.getByTestId('skill-toggle-write-tests')).toHaveAttribute('aria-checked', 'false')
  await panel.getByTestId('settings-close').click()

  await expect(page.getByTestId('skill-run-code-review')).toBeVisible()
  await expect(page.getByTestId('skill-run-write-tests')).toHaveCount(0)
})

test('running a skill sends its slash command to the Skills section session', async ({ page }) => {
  await openSkillsSection(page, scenarioWith(ON_SOURCE))
  await page.getByTestId('skill-run-code-review').click()

  const sends = async () => page.evaluate(() => window.__mock.state().sends)
  await expect.poll(async () => (await sends()).at(-1)?.text).toBe('/code-review')
  expect((await sends()).at(-1)?.sessionId).not.toBe('s-alpha')
  await expect(page.getByTestId('skills-view').getByTestId('mini-terminal')).toBeVisible()
})

test('a skill can be given an argument, the way a slash command takes one', async ({ page }) => {
  await openSkillsSection(page, scenarioWith(ON_SOURCE))
  await page.getByTestId('skill-arg-code-review').click()
  await page.getByTestId('skill-arg-input-code-review').fill('only the diff store')
  await page.getByTestId('skill-arg-input-code-review').press('Enter')

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toBe('/code-review only the diff store')
})

test('with nothing imported the section says so', async ({ page }) => {
  await openSkillsSection(page, twoProjectScenario())
  await expect(page.getByTestId('skills-empty')).toBeVisible()
  await expect(page.getByTestId('skills-all-off')).toHaveCount(0)
})

test('with every skill switched off the section says that instead, and opens Settings to fix it', async ({
  page,
}) => {
  await openSkillsSection(page, scenarioWith(ON_SOURCE.map((s) => ({ ...s, enabled: false }))))
  await expect(page.getByTestId('skills-all-off')).toContainText('2 imported skills are switched off')
  await expect(page.getByTestId('skills-empty')).toHaveCount(0)
  await page.getByTestId('skills-manage').click()
  await expect(page.getByTestId('settings-panel').getByTestId('skill-row-code-review')).toBeVisible()
})
