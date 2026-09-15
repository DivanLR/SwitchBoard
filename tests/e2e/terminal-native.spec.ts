import { _electron as electron, expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

test.skip(!process.env.TERMINAL_NATIVE, 'Opt-in test with the installed Codex CLI and native clipboard')

test('pastes native clipboard text into Codex without submitting a prompt', async () => {
  const testInfo = test.info()
  const main = resolve('out/terminal-native-main.mjs')
  await build({
    entryPoints: ['tests/fixtures/terminal-native-main.ts'],
    outfile: main,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    tsconfig: 'tsconfig.node.json',
  })
  const app = await electron.launch({ args: [main], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
  const savedClipboard = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }))
  try {
    const page = await app.firstWindow()
    const pane = page.getByTestId('terminal-pane')
    await expect(pane).toBeVisible()
    await expect(pane.locator('.xterm-rows')).toContainText('Codex', { timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath('codex-before.png') })
    await app.evaluate(({ clipboard }) => clipboard.writeText('SWITCHBOARD_CLIPBOARD_CHECK'))
    await pane.locator('.xterm-helper-textarea').press('Control+v')
    await expect(pane.locator('.xterm-rows')).toContainText('SWITCHBOARD_CLIPBOARD_CHECK', { timeout: 10_000 })
    await page.screenshot({ path: testInfo.outputPath('codex-pasted.png') })
  } finally {
    await app.evaluate(({ clipboard, nativeImage }, saved) => clipboard.write({ ...saved, image: nativeImage.createFromDataURL(saved.image) }), savedClipboard)
    await app.close()
  }
})
