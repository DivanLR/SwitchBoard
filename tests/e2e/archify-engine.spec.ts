// The Diagrams section's second engine.
//
// diagram-design draws from a sentence; archify commits to one of five types,
// authors a typed specification, validates it against a schema and only then
// compiles it. So the switch is not a skin: it changes the prompt that goes out,
// the commands in the menu, what "installed" means and how it is installed.
// Each of those four is a separate test below.
//
// Structure follows diagrams.spec.ts: installMockHost in beforeEach, select
// alpha, open the tab.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'
import { ARCHIFY, DIAGRAMS_DIR } from '../../src/shared/diagram'

/** archify, already imported and switched on. Shaped like the frontmatter a real
 *  SKILL.md carries, because that is what the importer records. */
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

/**
 * The last thing sent to any session, which is what a generate produces.
 *
 * Polled rather than read once: a command dispatched from the menu goes through
 * the parent's runPluginCommand, which has to reach a session before it can send
 * anything — the same reason diagrams.spec.ts polls for it.
 */
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
  // The interactive bar belongs to archify and only appears with it.
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
  // Five, and no sixth. "Choose for me" was removed: it routed through `archify
  // guide`, so the drawing depended on a second round trip and on whichever type
  // that router returned, which is a decision the developer is standing right
  // there to make.
  await expect(page.getByTestId('archify-type-auto')).toHaveCount(0)

  // It opens on architecture, and the hint under the chips is archify's own
  // sentence for whichever is chosen — the one thing that stops the five being
  // names with no meaning. A default outside the list would leave no chip
  // pressed and nothing saying what is about to be drawn.
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
  // The chosen type, honoured — this is the whole reason the bar exists.
  expect(sent).toContain('Use the sequence type')
  // The specification beside the diagram, then the delivery into the one folder
  // this section reads. The name is the app's, slugified from the description
  // (diagramFileName), which is what lets a finished file be matched back to the
  // sentence that asked for it.
  expect(sent).toContain(`${DIAGRAMS_DIR}/the-auth-flow.sequence.json`)
  expect(sent).toContain(`${DIAGRAMS_DIR}/the-auth-flow.html`)
  expect(sent).toContain('--quality showcase')
  // And the rule a background session cannot recover from on its own.
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

// Everything else on the archify bar shapes HOW it draws. The reference is the
// one control that changes WHAT it draws: the drawing flow could only ever work
// from one line of prose, so redrawing something that already existed meant
// describing it from memory.
test('a reference file reaches the session, and says which file it is on screen', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()

  const pick = page.getByTestId('archify-reference-pick')
  await expect(pick).toBeVisible()
  await expect(page.getByTestId('archify-reference-name')).toHaveCount(0)

  // Cancelled leaves the bar exactly as it was.
  await page.evaluate(() => window.__mock.setNextFilePick(null))
  await pick.click()
  await expect(pick).toBeVisible()
  await expect(page.getByTestId('archify-reference-name')).toHaveCount(0)

  await page.evaluate(() => window.__mock.setNextFilePick('C:\\Users\\d\\Desktop\\arch.drawio'))
  await pick.click()
  // The bare name on screen; the full path belongs on the clear button's title,
  // because a 300px rail cannot show a path and a control at once.
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
  // Read before authoring, or the skill draws the sentence and reconciles later.
  expect(sent.indexOf('arch.drawio')).toBeLessThan(sent.indexOf('fast authoring path'))
  // The rest of the bar is unaffected by carrying a file.
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

// The reference belongs to the drawing flow. A command line carries its own
// arguments, and the archify bar is hidden for one, so the control goes with it.
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
  // preview is listed and disabled rather than hidden: the menu still says what
  // the tool can do, and the row says why this one will not go from here.
  await expect(page.getByTestId('diagram-command-preview')).toBeDisabled()
  await expect(page.getByTestId('diagram-command-inert-preview')).toContainText('Ctrl-C')
})

test('a typed `archify preview` is refused, not just missing from the menu', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario([ARCHIFY_SKILL]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()

  const before = await page.evaluate(() => window.__mock.state().sends.length)
  // Typed by hand, never opening the menu. The menu's disabled row was the only
  // guard the sendable flag had, and it does not stand in this path at all: the
  // refusal has to live on the dispatch itself, or `archify preview` reaches a
  // background session and watches a file until something kills it.
  await page
    .getByTestId('diagram-input')
    .fill('archify preview architecture docs/diagrams/x.architecture.json')

  await expect(page.getByTestId('diagram-command-refused')).toContainText('Ctrl-C')
  await expect(page.getByTestId('diagram-generate')).toBeDisabled()

  // And Enter does not get round the disabled button.
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

  // Written, not sent: what runs is what is on screen.
  await expect(page.getByTestId('diagram-input')).toHaveValue('archify doctor ')
  await expect(page.getByTestId('diagram-command-hint')).toBeVisible()
  // The interactive bar stands down for a command, which carries its own arguments.
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
  // No skills imported at all.
  await page.addInitScript(installMockHost, scenario([]))
  await openDiagrams(page)
  await page.getByTestId('diagram-engine-archify').click()

  const install = page.getByTestId('diagrams-install')
  await expect(install).toBeVisible()
  await expect(install).toContainText('Import the skill')
  // It is a skill, so it names the repository the Skills importer reads, not a
  // plugin marketplace and package.
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
  // alpha's mock command list carries the plugin, so the card goes entirely.
  await expect(page.getByTestId('diagrams-install')).toHaveCount(0)
})
