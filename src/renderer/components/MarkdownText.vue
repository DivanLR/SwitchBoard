<script setup lang="ts">
// Renders an assistant response as formatted Markdown (bold, inline code,
// fenced code blocks, headings, lists). The HTML comes from renderMarkdown,
// which HTML-escapes first and emits only a fixed, attribute-free tag set, so
// v-html is safe here (no injection surface).
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { renderMarkdown } from '@shared/markdown'
import { useClipboardStore } from '@renderer/stores/clipboard'

const props = defineProps<{ text: string }>()
const html = computed(() => renderMarkdown(props.text))

const mdEl = useTemplateRef<HTMLElement>('md')
const clipboard = useClipboardStore()

/**
 * Which block was copied, by position, and NOT by a class on the block itself.
 *
 * The class alone could not survive: `v-html` is not diffed, so every streamed
 * token replaces this container's entire contents, taking the just-clicked
 * `<pre>` with it. Copying a block out of a message that was still arriving
 * therefore looked like it had done nothing — the clipboard write succeeded
 * every time, and the "copied" label was destroyed by the next token, usually
 * inside the 1200ms it was meant to be visible.
 *
 * The index lives out here in component state, where a re-render cannot reach
 * it, and is re-applied to the new DOM after each one.
 */
const copiedIndex = ref<number | null>(null)
/**
 * Whether that block's copy actually WORKED.
 *
 * The failure path used to return silently, on the sound reasoning that the
 * label must never claim a copy that did not happen. Saying nothing is the
 * wrong way to honour that: a click that produces no label at all is
 * indistinguishable from a click the app never received, so a denied clipboard
 * read as a broken feature. The mark now reports either outcome; only the
 * wording changes.
 */
const copiedOk = ref(true)
let clearTimer: ReturnType<typeof setTimeout> | null = null

function markCopied(): void {
  const blocks = mdEl.value?.querySelectorAll('pre.md-pre')
  if (!blocks) return
  blocks.forEach((block, index) => {
    const marked = index === copiedIndex.value
    block.classList.toggle('copied', marked && copiedOk.value)
    block.classList.toggle('copy-failed', marked && !copiedOk.value)
  })
}

// After the re-render that just wiped it, put the mark back — but only when
// there is a mark to restore. Watching both together ran a querySelectorAll over
// every block on every streamed token of every message, for the whole session,
// to re-apply nothing.
watch(html, () => {
  if (copiedIndex.value !== null) void nextTick(markCopied)
})
watch([copiedIndex, copiedOk], () => void nextTick(markCopied))

/**
 * Click a code block to copy it.
 *
 * One delegated listener rather than a button per block: renderMarkdown emits a
 * fixed, attribute-free tag set — which is exactly what makes the v-html above
 * safe — so injecting controls into its output would give that up, and appending
 * them afterwards would mean re-attaching on every streamed re-render.
 *
 * The write goes through the clipboard STORE, not `navigator.clipboard`. That
 * API is gated by Electron's permission handlers, which this app sets to deny by
 * default, and it also requires a focused document — two different ways to make
 * a click report that it could not copy. See stores/clipboard.ts.
 */
async function copyBlock(event: MouseEvent): Promise<void> {
  const pre = (event.target as HTMLElement | null)?.closest?.('pre.md-pre')
  if (!(pre instanceof HTMLElement)) return
  // Selecting a few lines inside a block and releasing the mouse is a copy the
  // developer is already making by hand; taking the whole block instead would
  // overwrite what they just chose (SessionView guards Ctrl+C the same way).
  if ((window.getSelection()?.toString() ?? '').length > 0) return
  // Reported either way. The label never claims a copy that did not happen, and
  // never stays silent either: a click producing no label at all is
  // indistinguishable from a click the app never received.
  const ok = await clipboard.write(pre.textContent ?? '')
  const blocks = [...(mdEl.value?.querySelectorAll('pre.md-pre') ?? [])]
  copiedOk.value = ok
  copiedIndex.value = blocks.indexOf(pre)
  markCopied()
  // Restarted, not stacked: copying a second block while the first is still
  // marked must move the mark, not have the first block's timer clear it early.
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    clearTimer = null
    copiedIndex.value = null
    markCopied()
  }, 1200)
}

// Harmless today only because markCopied() guards on mdEl.value being null once
// the component is torn down, so a timer firing after unmount finds nothing to
// mark. That guard is not a substitute for cleanup — it just happens to make
// this particular timer's callback a no-op — so clear it explicitly here. The
// pairing keeps the next timer someone adds to this file safe by default,
// instead of relying on it to rediscover the same accidental guard.
onUnmounted(() => {
  if (clearTimer) clearTimeout(clearTimer)
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- content is escaped + tag-whitelisted by renderMarkdown -->
  <div ref="md" class="md" data-testid="markdown-text" @click="copyBlock" v-html="html"></div>
</template>

<style scoped>
.md {
  font-size: var(--fs-body);
  line-height: 1.55;
  color: var(--text-body);
  text-wrap: pretty;
  word-break: break-word;
}

.md :deep(p) {
  margin: 0 0 8px;
}

.md :deep(p:last-child) {
  margin-bottom: 0;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-title);
  margin: 12px 0 6px;
}

.md :deep(h1:first-child),
.md :deep(h2:first-child),
.md :deep(h3:first-child) {
  margin-top: 0;
}

.md :deep(strong) {
  color: var(--text-title);
  font-weight: var(--w-em);
}

.md :deep(em) {
  font-style: italic;
}

.md :deep(ul),
.md :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.md :deep(li) {
  margin: 2px 0;
}

/* Inline code: subtle chip in the monospace face. */
.md :deep(code) {
  font-family: var(--mono);
  font-size: var(--fs-ui);
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: var(--rc);
  padding: 0 4px;
  color: var(--text-body);
}

/* THE CODE CARD.
   A fenced code block, presented the way the pinned reference presents one
   (design.dev code-screenshot-generator): a window of code with its own chrome
   bar, generous padding, a real corner and a soft lift off the message it sits
   in. It scrolls horizontally rather than pushing the stream width out.

   DRAWN ENTIRELY IN CSS, chrome bar and all. renderMarkdown guarantees an
   attribute-free HTML set, and the copy label below has always been a
   pseudo-element for exactly that reason; the chrome is the same bargain. A
   markup-based chrome bar would mean the sanitiser has to start allowing
   structure, which is a much larger promise to break for a decorative strip.

   IT IS NOT A SCREENSHOT. The reference exports a PNG; code in a session stream
   has to stay selectable, searchable and copyable, so what is taken is the
   card's language and not its output format. */
.md :deep(pre.md-pre) {
  background: var(--surface-code);
  border: 1px solid var(--border-code);
  /* The panel radius, shared with the palette and the toast. A code card is a
     lifted artifact like those are, not a fold in the page. */
  border-radius: var(--r-panel);
  /* Top padding clears the chrome bar the ::before below draws. */
  padding: 32px 14px 14px;
  margin: 0 0 10px;
  overflow-x: auto;
  /* Anchors the chrome bar and the copy label. */
  position: relative;
  cursor: pointer;
  box-shadow: var(--elev);
}

/* THE CHROME BAR. One pseudo-element carrying the strip, with the three window
   dots painted into it as gradients.

   THE DOTS ARE NEUTRAL, NOT TRAFFIC LIGHTS, and this is the one place the
   reference is not followed literally. Red, amber and green are load-bearing in
   this world: they mean error, attention owed, and running. Three of them
   sitting decoratively on top of every code block would be the single loudest
   contradiction of the rule the whole palette is built on. The chrome still
   reads as chrome; it just does not lie about status. */
.md :deep(pre.md-pre)::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 26px;
  background:
    radial-gradient(circle 4px at 14px 13px, var(--text-ghost) 96%, transparent 100%),
    radial-gradient(circle 4px at 30px 13px, var(--text-ghost) 96%, transparent 100%),
    radial-gradient(circle 4px at 46px 13px, var(--text-ghost) 96%, transparent 100%),
    var(--bg-chip);
  border-bottom: 1px solid var(--border-code);
  border-radius: var(--r-panel) var(--r-panel) 0 0;
  opacity: 0.75;
  /* The bar must not scroll away with a long line of code. */
  pointer-events: none;
}

/* The copy affordance now lives IN the chrome bar and is always legible, rather
   than appearing on hover. The reference puts its export control on the frame
   permanently, and a copy you have to discover by hovering is a copy most people
   never find. Hover and the copied state still strengthen it. */
.md :deep(pre.md-pre)::after {
  content: 'copy';
  position: absolute;
  top: 5px;
  right: 10px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.06em;
  color: var(--text-ghost);
  opacity: 0.85;
  transition: opacity 0.12s var(--ease), color 0.12s var(--ease);
  pointer-events: none;
}

.md :deep(pre.md-pre:hover)::after {
  opacity: 1;
  color: var(--text-mid);
}

/* GREY, not green, on the owner's direction (2026-08-21) — and it is the more
   correct reading of this world's own rule. Colour here is spent on a reading
   outside tolerance; a copy that worked is neither out of tolerance nor an
   action still running, so it has no claim on the accent. A copy that FAILED is
   out of tolerance, and takes red below.

   It still has to read as a CHANGE, though, and it cannot do that with hue. So
   it takes the top of the neutral ramp and the emphasis weight, which puts it a
   clear step above both the resting label (--text-ghost at 0.85) and the hover
   one (--text-mid at 1). Grey, and unmistakably different from the grey it
   replaced. */
.md :deep(pre.md-pre.copied)::after {
  content: 'copied';
  color: var(--text-strong);
  font-weight: var(--w-em);
  opacity: 1;
}

/* The one outcome here that IS a fault, so the one that earns colour. Named
   plainly: "failed" alone would leave the developer wondering what to do, and
   the answer is almost always that the window is not focused. */
.md :deep(pre.md-pre.copy-failed)::after {
  content: 'could not copy';
  color: var(--red);
  font-weight: var(--w-em);
  opacity: 1;
}

/* The bar separates from a body that is DARKER than it, so it takes the canvas
   tone rather than the translucent chip wash: the chip wash is ink-over-surface,
   which on a sunken body only makes it darker still. */
html.sb-light .md :deep(pre.md-pre)::before {
  background:
    radial-gradient(circle 4px at 14px 13px, var(--text-ghost) 96%, transparent 100%),
    radial-gradient(circle 4px at 30px 13px, var(--text-ghost) 96%, transparent 100%),
    radial-gradient(circle 4px at 46px 13px, var(--text-ghost) 96%, transparent 100%),
    var(--bg);
}

@media (prefers-reduced-motion: reduce) {
  .md :deep(pre.md-pre)::after {
    transition: none;
  }
}

.md :deep(pre.md-pre code) {
  /* Up from --fs-meta (11px). 11px is this world's density floor, chosen so a
     sidebar row can hold six facts; a code example is read line by line and the
     reference does not offer anything below 14px. --fs-body is the compromise
     that keeps the stream's own rhythm. */
  font-size: var(--fs-body);
  line-height: 1.6;
  background: none;
  border: none;
  border-radius: 0;
  padding: 0;
  color: var(--text-body);
  white-space: pre;
}

/* Tables (analysis reports, comparisons): card chrome, hairline rows, and a
   horizontal scroll wrapper so wide tables never stretch the stream. */
.md :deep(.md-table-wrap) {
  overflow-x: auto;
  margin: 0 0 8px;
  border: 1px solid var(--border-soft);
  border-radius: var(--rc);
}

.md :deep(table.md-table) {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--fs-ui);
  line-height: 1.5;
}

.md :deep(.md-table th) {
  text-align: left;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-meta);
  background: var(--bg-chip);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-strong);
  white-space: nowrap;
}

.md :deep(.md-table td) {
  padding: 6px 10px;
  vertical-align: top;
  color: var(--text-body);
  border-bottom: 1px solid var(--border-soft);
}

.md :deep(.md-table tbody tr:last-child td) {
  border-bottom: none;
}
</style>
