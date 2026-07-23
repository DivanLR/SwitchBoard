<script setup lang="ts">
// Renders an assistant response as formatted Markdown (bold, inline code,
// fenced code blocks, headings, lists). The HTML comes from renderMarkdown,
// which HTML-escapes first and emits only a fixed, attribute-free tag set, so
// v-html is safe here (no injection surface).
import { computed } from 'vue'
import { renderMarkdown } from '@shared/markdown'

const props = defineProps<{ text: string }>()
const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- content is escaped + tag-whitelisted by renderMarkdown -->
  <div class="md" v-html="html"></div>
</template>

<style scoped>
.md {
  font-size: 13px;
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
  font-size: 13.5px;
  font-weight: 700;
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
  font-weight: 700;
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
  font-size: 12px;
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
}

.md :deep(pre.md-pre code) {
  font-size: 11.8px;
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
  font-size: 12px;
  line-height: 1.5;
}

.md :deep(.md-table th) {
  text-align: left;
  font-family: var(--mono);
  font-size: 10.5px;
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
