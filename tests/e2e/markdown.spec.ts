// Assistant responses render Markdown (bold, inline code, fenced blocks) in the
// clean view rather than showing raw markup.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

test('a Markdown response renders bold, inline code, and a fenced code block', async ({ page }) => {
  await page.evaluate(() => {
    const text = [
      '**Ponytail Audit Results**',
      '',
      'One finding, minor.',
      '',
      '```',
      'shrink  TextUtils: `?? new List()` -> `?? []`. [Chat/TextUtils.cs:17]',
      '```',
      '',
      '**net: -20 lines possible.**',
    ].join('\n')
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text, partial: false })
  })

  const event = page.getByTestId('stream-event-assistant_text')
  await expect(event.locator('strong').first()).toHaveText('Ponytail Audit Results')
  await expect(event.locator('pre.md-pre code')).toContainText('shrink  TextUtils')
  // Markers inside the fence remain literal, not re-formatted.
  await expect(event.locator('pre.md-pre code')).toContainText('`?? []`')
  await expect(event.locator('pre.md-pre strong')).toHaveCount(0)
  // Raw markup is not shown as literal text outside the code block.
  await expect(event.locator('p').filter({ hasText: 'One finding' })).toBeVisible()
})

// Code the session hands back is code the developer wants to run; before this
// there was no way to lift it out of the stream but to select it by hand.
test('a code block is copied by clicking it, and says so', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: ['Run this:', '', '```', 'npm run check', '```'].join('\n'),
      partial: false,
    })
  })

  const block = page.getByTestId('stream-event-assistant_text').locator('pre.md-pre')
  await block.click()

  await expect(block).toHaveClass(/copied/)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('npm run check')
})

// The bug this guards: v-html is not diffed, so every streamed token replaces
// this message's whole subtree, taking the just-clicked block with it. Copying
// out of a message that was still arriving looked like it had done nothing —
// the clipboard write always succeeded, the "copied" mark was destroyed by the
// next token. The old test above only ever emitted a finished message, so the
// suite passed while the bug was live.
test('the copied mark survives the next streamed token', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const eventId = await page.evaluate(() =>
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: ['Run this:', '', '```', 'npm run check', '```'].join('\n'),
      partial: true,
    }),
  )

  const block = page.getByTestId('stream-event-assistant_text').locator('pre.md-pre')
  await block.click()
  await expect(block).toHaveClass(/copied/)

  // The message keeps arriving, which rebuilds the block the mark was sitting on.
  await page.evaluate((id) => {
    window.__mock.updateEvent('s-alpha', id, {
      text: ['Run this:', '', '```', 'npm run check', '```', '', 'Then read the output.'].join('\n'),
      partial: true,
    })
  }, eventId)

  await expect(page.getByTestId('stream-event-assistant_text')).toContainText('Then read the output')
  await expect(
    page.getByTestId('stream-event-assistant_text').locator('pre.md-pre'),
  ).toHaveClass(/copied/)
})

test('selecting inside a code block is not overwritten by the copy', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(async () => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: ['```', 'first line', 'second line', '```'].join('\n'),
      partial: false,
    })
    await navigator.clipboard.writeText('what the developer already copied')
  })

  const block = page.getByTestId('stream-event-assistant_text').locator('pre.md-pre')
  // A selection inside the block is a copy the developer is already making.
  await page.evaluate(() => {
    const code = document.querySelector('pre.md-pre code')
    const range = document.createRange()
    range.selectNodeContents(code!)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
  await block.click({ position: { x: 5, y: 5 } })

  await expect(block).not.toHaveClass(/copied/)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'what the developer already copied',
  )
})

test('a Markdown response cannot inject HTML', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: 'danger <img src=x onerror="window.__pwned=1"> done',
      partial: false,
    })
  })
  await expect(page.getByTestId('stream-event-assistant_text')).toContainText('<img')
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
})

// Copying a code block, and SAYING SO. The label is the whole feature: the
// clipboard write itself has always worked, and the confirmation is what tells
// the developer their click landed.
//
// Both outcomes are pinned, because the failure path is the one that was broken.
// It used to return silently on the sound reasoning that the label must never
// claim a copy that did not happen — but a click producing no label at all is
// indistinguishable from a click the app never received, so a denied clipboard
// read as a dead feature.
async function emitBlock(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: ['```ts', 'const timeout = input.timeout ?? 5_000', '```'].join('\n'),
      partial: false,
    })
  })
}

/** The label's own computed text, which is a ::after content string. */
async function label(page: import('@playwright/test').Page): Promise<string> {
  return page
    .locator('pre.md-pre')
    .first()
    .evaluate((el) => getComputedStyle(el, '::after').content)
}

test('a copied code block says copied, in the neutral ink rather than the accent', async ({
  page,
}) => {
  await emitBlock(page)
  const pre = page.locator('pre.md-pre').first()
  await expect(pre).toBeVisible()

  expect(await label(page)).toContain('copy')

  await pre.click()
  await expect.poll(() => label(page)).toContain('copied')
  // Grey, not green: colour in this world is spent on a reading outside
  // tolerance, and a copy that worked is not one. It still has to read as a
  // change, which is what the emphasis weight buys.
  const state = await pre.evaluate((el) => {
    const cs = getComputedStyle(el, '::after')
    return { color: cs.color, weight: cs.fontWeight }
  })
  expect(state.weight).toBe('500')
  expect(state.color).not.toBe('rgb(63, 191, 180)') // trace-green, dark
  expect(state.color).not.toBe('rgb(18, 118, 110)') // trace-green, light
})

test('a copy that fails says so, instead of saying nothing at all', async ({ page }) => {
  // Forced through the mock host rather than by clearing browser permissions.
  // The copy no longer goes through `navigator.clipboard` at all — it is an IPC
  // call to the main process — so a browser permission has nothing to do with
  // whether it succeeds, and a test that revoked one would be proving nothing.
  await page.evaluate(() => window.__mock.setClipboardFails(true))
  await emitBlock(page)
  const pre = page.locator('pre.md-pre').first()
  await expect(pre).toBeVisible()

  await pre.click()
  // Never claims success, and never stays silent either.
  await expect.poll(() => label(page)).toContain('could not copy')
})
