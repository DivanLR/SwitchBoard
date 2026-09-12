<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { renderMarkdown } from '@shared/markdown'
import { useClipboardStore } from '@renderer/stores/clipboard'

const props = defineProps<{ text: string }>()
const html = computed(() => renderMarkdown(props.text))

const mdEl = useTemplateRef<HTMLElement>('md')
const clipboard = useClipboardStore()

const copiedIndex = ref<number | null>(null)
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

watch(html, () => {
  if (copiedIndex.value !== null) void nextTick(markCopied)
})
watch([copiedIndex, copiedOk], () => void nextTick(markCopied))

async function copyBlock(event: MouseEvent): Promise<void> {
  const pre = (event.target as HTMLElement | null)?.closest?.('pre.md-pre')
  if (!(pre instanceof HTMLElement)) return
  if ((window.getSelection()?.toString() ?? '').length > 0) return
  const ok = await clipboard.write(pre.textContent ?? '')
  const blocks = [...(mdEl.value?.querySelectorAll('pre.md-pre') ?? [])]
  copiedOk.value = ok
  copiedIndex.value = blocks.indexOf(pre)
  markCopied()
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    clearTimer = null
    copiedIndex.value = null
    markCopied()
  }, 1200)
}

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

.md :deep(code) {
  font-family: var(--mono);
  font-size: var(--fs-ui);
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: var(--rc);
  padding: 0 4px;
  color: var(--text-body);
}

.md :deep(pre.md-pre) {
  background: var(--surface-code);
  border: 1px solid var(--border-code);
  border-radius: var(--r-panel);
  padding: 32px 14px 14px;
  margin: 0 0 10px;
  overflow-x: auto;
  position: relative;
  cursor: pointer;
  box-shadow: var(--elev);
}

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
  pointer-events: none;
}

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

.md :deep(pre.md-pre.copied)::after {
  content: 'copied';
  color: var(--text-strong);
  font-weight: var(--w-em);
  opacity: 1;
}

.md :deep(pre.md-pre.copy-failed)::after {
  content: 'could not copy';
  color: var(--red);
  font-weight: var(--w-em);
  opacity: 1;
}

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
  font-size: var(--fs-body);
  line-height: 1.6;
  background: none;
  border: none;
  border-radius: 0;
  padding: 0;
  color: var(--text-body);
  white-space: pre;
}

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
