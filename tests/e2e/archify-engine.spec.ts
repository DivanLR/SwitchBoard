import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'
import { ARCHIFY, DIAGRAMS_DIR } from '../../src/shared/diagram'

const ARCHIFY_SKILL = {
  name: ARCHIFY.skill,
  description: 'Create polished, validated diagrams as explorable standalone HTML.',
  sourceUrl: ARCHIFY.source,
  sourcePath: 'archify',
  enabled: true,
  fileCount: 190,
  importedAt: '2026-08-30T09:00:00.000Z',
}

function scenario(skills: MockScenario['skills'] = []): MockScenario {
  return { ...twoProjectScenario(), skills }
}

async function openDiagrams(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-diagrams').click()
  await expect(page.getByTestId('diagrams-view')).toBeVisible()
}

async function lastSend(page: import('@playwright/test').Page): Promise<string> {
  await expect
    .poll(async () => page.evaluate(() => window.__mock.state().sends.length))
    .toBeGreaterThan(0)
  return page.evaluate(() => (window.__mock.state().sends.at(-1)?.text as string) ?? '')
}

test('the section opens on diagram-design, and the engine is a deliberate choice', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)

  await expect(page.getByTestId('diagram-engine-diagram-design')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('diagram-engine-archify')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('archify-options')).toHaveCount(0)
})

test('switching to archify offers its five types, and says what each is for', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()

  await expect(page.getByTestId('archify-options')).toBeVisible()
  for (const type of ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']) {
    await expect(page.getByTestId(`archify-type-${type}`)).toBeVisible()
  }
  await expect(page.getByTestId('archify-type-auto')).toHaveCount(0)

  await expect(page.getByTestId('archify-type-architecture')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByTestId('archify-type-sequence').click()
  await expect(page.getByTestId('archify-type-sequence')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('archify-type-architecture')).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.getByTestId('archify-options')).toContainText('API call chains')
})

test('the engine survives leaving the tab, because it is a preference and not a mood', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await expect(page.getByTestId('archify-options')).toBeVisible()

  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-diagrams').click()
  await expect(page.getByTestId('diagram-engine-archify')).toHaveAttribute('aria-pressed', 'true')
})

test('generating through archify sends the pipeline, not a request for a picture', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await page.getByTestId('archify-type-sequence').click()
  await page.getByTestId('diagram-input').fill('the auth flow')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sent = await lastSend(page)
  expect(sent).toContain('archify skill')
  expect(sent).toContain('Use the sequence type')
  expect(sent).toContain(`${DIAGRAMS_DIR}/the-auth-flow.sequence.json`)
  expect(sent).toContain(`${DIAGRAMS_DIR}/the-auth-flow.html`)
  expect(sent).toContain('--quality showcase')
  expect(sent).toContain('NEVER run `archify preview`')
})

test('the quality and viewer switches reach the session', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await page.getByTestId('archify-quality-standard').click()
  await page.getByTestId('archify-motion').click()
  await expect(page.getByTestId('archify-motion')).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('diagram-input').fill('the pipeline')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sent = await lastSend(page)
  expect(sent).toContain('--quality standard')
  expect(sent).toContain('meta.animation to "trace"')
})

test('a reference file reaches the session, and says which file it is on screen', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()

  const pick = page.getByTestId('archify-reference-pick')
  await expect(pick).toBeVisible()
  await expect(page.getByTestId('archify-reference-name')).toHaveCount(0)

  await page.evaluate(() => window.__mock.setNextFilePick(null))
  await pick.click()
  await expect(pick).toBeVisible()
  await expect(page.getByTestId('archify-reference-name')).toHaveCount(0)

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\Users\\d\\Desktop\\arch.drawio'))
  await pick.click()
  await expect(page.getByTestId('archify-reference-name')).toHaveText('arch.drawio')
  await expect(page.getByTestId('archify-reference-clear')).toHaveAttribute(
    'title',
    /C:\\Users\\d\\Desktop\\arch\.drawio/,
  )

  await page.getByTestId('diagram-input').fill('the auth flow')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sent = await lastSend(page)
  expect(sent).toContain('"C:\\Users\\d\\Desktop\\arch.drawio"')
  expect(sent.indexOf('arch.drawio')).toBeLessThan(sent.indexOf('fast authoring path'))
  expect(sent).toContain('--quality showcase')
})

test('clearing the reference goes back to drawing from the sentence alone', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\Users\\d\\Desktop\\arch.drawio'))
  await page.getByTestId('archify-reference-pick').click()
  await expect(page.getByTestId('archify-reference-name')).toBeVisible()

  await page.getByTestId('archify-reference-clear').click()
  await expect(page.getByTestId('archify-reference-name')).toHaveCount(0)
  await expect(page.getByTestId('archify-reference-pick')).toBeVisible()

  await page.getByTestId('diagram-input').fill('the auth flow')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sent = await lastSend(page)
  expect(sent).not.toContain('arch.drawio')
  expect(sent).not.toMatch(/read it first/i)
})

test('the reference control is absent on the diagram-design engine and for a command', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await expect(page.getByTestId('archify-reference-pick')).toHaveCount(0)

  await page.getByTestId('diagram-engine-archify').click()
  await expect(page.getByTestId('archify-reference-pick')).toBeVisible()

  await page.getByTestId('diagram-input').fill('archify doctor')
  await expect(page.getByTestId('archify-reference-pick')).toHaveCount(0)
})

test('the other engine is untouched by any of it', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-input').fill('the auth flow')
  await page.getByTestId('diagram-generate').click()
  await expect(page.getByTestId('diagram-pending')).toBeVisible()

  const sent = await lastSend(page)
  expect(sent).toContain('Use the default editorial skin')
  expect(sent).not.toContain('archify')
})

test('the commands menu carries archify’s CLI, and refuses the one that never returns', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await page.getByTestId('diagram-commands').click()

  const menu = page.getByTestId('diagram-command-menu')
  await expect(menu).toBeVisible()
  for (const command of ['doctor', 'guide', 'validate', 'deliver', 'visual-check', 'demo']) {
    await expect(page.getByTestId(`diagram-command-${command}`)).toBeVisible()
  }
  await expect(page.getByTestId('diagram-command-preview')).toBeDisabled()
  await expect(page.getByTestId('diagram-command-inert-preview')).toContainText('Ctrl-C')
})

test('a typed `archify preview` is refused, not just missing from the menu', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()

  const before = await page.evaluate(() => window.__mock.state().sends.length)
  await page
    .getByTestId('diagram-input')
    .fill('archify preview architecture docs/diagrams/x.architecture.json')

  await expect(page.getByTestId('diagram-command-refused')).toContainText('Ctrl-C')
  await expect(page.getByTestId('diagram-generate')).toBeDisabled()

  await page.getByTestId('diagram-input').press('Enter')
  expect(await page.evaluate(() => window.__mock.state().sends.length)).toBe(before)
})

test('every other archify command still sends', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await page.getByTestId('diagram-input').fill('archify validate workflow spec.json')

  await expect(page.getByTestId('diagram-command-refused')).toHaveCount(0)
  await expect(page.getByTestId('diagram-generate')).toBeEnabled()
})

test('picking a command writes it, and sending runs it through the skill’s own bin', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await page.getByTestId('diagram-commands').click()
  await page.getByTestId('diagram-command-doctor').click()

  await expect(page.getByTestId('diagram-input')).toHaveValue('archify doctor ')
  await expect(page.getByTestId('diagram-command-hint')).toBeVisible()
  await expect(page.getByTestId('archify-options')).toHaveCount(0)

  await page.getByTestId('diagram-generate').click()
  const sent = await lastSend(page)
  expect(sent).toContain(`node ${ARCHIFY.bin} doctor`)
  expect(sent).toContain(DIAGRAMS_DIR)
})

test('an archify command is a command, so the button says Send rather than Generate', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await page.getByTestId('diagram-input').fill('archify examples')
  await expect(page.getByTestId('diagram-generate')).toContainText('Send')

  await page.getByTestId('diagram-input').fill('the auth flow')
  await expect(page.getByTestId('diagram-generate')).toContainText('Generate')
})

test('without the skill, the section offers to import it rather than failing later', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()

  const install = page.getByTestId('diagrams-install')
  await expect(install).toBeVisible()
  await expect(install).toContainText('Import the skill')
  await expect(page.getByTestId('diagram-engine').locator('..')).toContainText('archify')
})

test('switching back to diagram-design does not inherit archify’s missing-skill card', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await expect(page.getByTestId('diagrams-install')).toContainText('Import the skill')

  await page.getByTestId('diagram-engine-diagram-design').click()
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
})

test('the pipeline is shown as stages, and advances on what the session actually ran', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await page.getByTestId('archify-type-sequence').click()
  await page.getByTestId('diagram-input').fill('the auth flow')
  await page.getByTestId('diagram-generate').click()

  const steps = page.getByTestId('archify-steps')
  await expect(steps).toBeVisible();
  await expect(page.getByTestId(/^archify-step-/)).toHaveCount(6)
  await expect(page.getByTestId('archify-step-schema')).toBeVisible()

  await expect(page.getByTestId('archify-step-type')).toHaveClass(/now|done/)
  await expect(page.getByTestId('archify-step-validate')).not.toHaveClass(/done/)

  const sessionId = await page.evaluate(
    () => window.__mock.state().sends.at(-1)?.sessionId as string,
  )

  await page.evaluate(
    (id) => window.__mock.emitEvent(id, 'assistant_text', { text: 'Now I will validate and deliver.' }),
    sessionId,
  )
  await expect(page.getByTestId('archify-step-validate')).not.toHaveClass(/done/)

  await page.evaluate(
    (id) =>
      window.__mock.emitEvent(id, 'tool_activity', {
        toolName: 'Bash',
        inputPreview: '{"command":"node ~/.claude/skills/archify/bin/archify.mjs validate sequence docs/diagrams/the-auth-flow.sequence.json --json"}',
      }),
    sessionId,
  )
  await expect(page.getByTestId('archify-step-validate')).toHaveClass(/done|now/)
})

test('the commands menu groups archify by pipeline stage, in order', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()
  await page.getByTestId('diagram-commands').click()

  const menu = page.getByTestId('diagram-command-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.cmd-group-label')).toHaveText([
    'Before you draw',
    'Author and check the specification',
    'Deliver',
    'Verify what was delivered',
  ])

  const rows = menu.locator('button[data-testid^="diagram-command-"]')
  await expect(rows).toHaveCount(14)

  const names = await rows.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid') ?? ''),
  )
  expect(names.indexOf('diagram-command-validate')).toBeLessThan(
    names.indexOf('diagram-command-deliver'),
  )
  expect(names.indexOf('diagram-command-deliver')).toBeLessThan(
    names.indexOf('diagram-command-check'),
  )
})

test('the diagram-design menu stays flat, because its commands are not a pipeline', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-commands').click()
  await expect(page.getByTestId('diagram-command-menu')).toBeVisible()
  await expect(page.getByTestId('diagram-command-menu').locator('.cmd-group-label')).toHaveCount(0)
})
