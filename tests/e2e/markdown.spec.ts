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
