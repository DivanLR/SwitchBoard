<script setup lang="ts">
// Renders an assistant response as formatted Markdown (bold, inline code,
// fenced code blocks, headings, lists). The HTML comes from renderMarkdown,
// which HTML-escapes first and emits only a fixed, attribute-free tag set, so
// v-html is safe here (no injection surface).
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { renderMarkdown } from '@shared/markdown'

const props = defineProps<{ text: string }>()
const html = computed(() => renderMarkdown(props.text))

const mdEl = useTemplateRef<HTMLElement>('md')

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
let clearTimer: ReturnType<typeof setTimeout> | null = null

function markCopied(): void {
  const blocks = mdEl.value?.querySelectorAll('pre.md-pre')
  if (!blocks) return
  blocks.forEach((block, index) => {
    block.classList.toggle('copied', index === copiedIndex.value)
  })
}

// After the re-render that just wiped it, put the mark back — but only when
// there is a mark to restore. Watching both together ran a querySelectorAll over
// every block on every streamed token of every message, for the whole session,
// to re-apply nothing.
watch(html, () => {
  if (copiedIndex.value !== null) void nextTick(markCopied)
})
watch(copiedIndex, () => void nextTick(markCopied))

/**
 * Click a code block to copy it.
 *
 * One delegated listener rather than a button per block: renderMarkdown emits a
 * fixed, attribute-free tag set — which is exactly what makes the v-html above
 * safe — so injecting controls into its output would give that up, and appending
 * them afterwards would mean re-attaching on every streamed re-render.
 *
 * `app://` is registered as a secure scheme (see registerSchemesAsPrivileged in
 * src/main/index.ts) and dev runs on localhost, so the clipboard API is
 * available in both; no IPC, and no exception to the rule that only stores
 * invoke.
 */
async function copyBlock(event: MouseEvent): Promise<void> {
  const pre = (event.target as HTMLElement | null)?.closest?.('pre.md-pre')
  if (!(pre instanceof HTMLElement)) return
  // Selecting a few lines inside a block and releasing the mouse is a copy the
  // developer is already making by hand; taking the whole block instead would
  // overwrite what they just chose (SessionView guards Ctrl+C the same way).
  if ((window.getSelection()?.toString() ?? '').length > 0) return
  try {
    await navigator.clipboard.writeText(pre.textContent ?? '')
  } catch {
    // Denied or unavailable: leave the block unmarked rather than claiming a
    // copy that did not happen.
    return
  }
  const blocks = [...(mdEl.value?.querySelectorAll('pre.md-pre') ?? [])]
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

/* Fenced code block: dark monospace panel that scrolls horizontally rather
   than pushing the stream width out. */
.md :deep(pre.md-pre) {
  background: var(--bg-code);
  border: 1px solid var(--border-soft);
  border-radius: var(--rc);
  padding: 10px 12px;
  margin: 0 0 8px;
  overflow-x: auto;
  /* Anchors the copy label below. */
  position: relative;
  cursor: pointer;
}

/* The affordance is a label drawn by CSS rather than a button in the markup, so
   the rendered HTML stays the attribute-free set renderMarkdown guarantees. It
   appears on hover, and states the outcome for the moment after the click. */
.md :deep(pre.md-pre)::after {
  content: 'copy';
  position: absolute;
  top: 6px;
  right: 8px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.06em;
  color: var(--text-ghost);
  background: var(--bg-code);
  padding: 1px 5px;
  border: 1px solid var(--border-soft);
  opacity: 0;
  transition: opacity 0.12s var(--ease);
  pointer-events: none;
}

.md :deep(pre.md-pre:hover)::after {
  opacity: 1;
}

.md :deep(pre.md-pre.copied)::after {
  content: 'copied';
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 45%, transparent);
  opacity: 1;
}

.md :deep(pre.md-pre code) {
  font-size: var(--fs-meta);
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
