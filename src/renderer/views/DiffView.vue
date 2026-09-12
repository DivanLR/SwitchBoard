<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { DiffFileEntry } from '@shared/domain'
import { useDiffStore } from '@renderer/stores/diff'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ projectId: string }>()
const diff = useDiffStore()

const anchor = ref<number | null>(null)
const head = ref<number | null>(null)
const instruction = ref('')
const composer = ref<HTMLTextAreaElement | null>(null)

const range = computed<[number, number] | null>(() => {
  if (anchor.value === null || head.value === null) return null
  return anchor.value <= head.value ? [anchor.value, head.value] : [head.value, anchor.value]
})

const selectedLines = computed<string[]>(() => {
  const r = range.value
  const lines = diff.fileDiff?.lines
  if (!r || !lines) return []
  return lines.slice(r[0], r[1] + 1).map((l) => {
    const marker = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '
    return `${marker}${l.text}`
  })
})

const isSelected = (i: number): boolean => {
  const r = range.value
  return r !== null && i >= r[0] && i <= r[1]
}

function pickLine(i: number, extend: boolean): void {
  if (extend && anchor.value !== null) {
    head.value = i
  } else {
    anchor.value = i
    head.value = i
  }
  diff.applyError = null
  void nextTick(() => composer.value?.focus())
}

function clearSelection(): void {
  anchor.value = null
  head.value = null
  instruction.value = ''
  diff.applyError = null
}

watch(() => diff.selectedPath, clearSelection)

async function sendInstruction(): Promise<void> {
  const text = instruction.value.trim()
  if (!text || !diff.selectedPath || selectedLines.value.length === 0) return
  const sent = await diff.applyToRegion(
    props.projectId,
    diff.selectedPath,
    selectedLines.value,
    text,
  )
  if (sent) clearSelection()
}

const result = computed(() => diff.resultFor(props.projectId))
const notLive = computed(() => diff.isNotLive(props.projectId))
const files = computed(() => result.value.files)

interface DiffGroup {
  dir: string
  label: string
  depth: number
  files: DiffFileEntry[]
  added: number | null
  removed: number | null
  total: number
}

const groups = computed<DiffGroup[]>(() => {
  const byDir = Object.groupBy(files.value, (file) => {
    const cut = file.path.lastIndexOf('/')
    return cut === -1 ? '' : file.path.slice(0, cut)
  })

  const dirs = new Set<string>()
  for (const dir of Object.keys(byDir)) {
    dirs.add(dir)
    const parts = dir === '' ? [] : dir.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }

  const ordered = [...dirs].sort((a, b) => {
    if (a === '') return -1
    if (b === '') return 1
    const x = a.split('/')
    const y = b.split('/')
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const cmp = x[i].localeCompare(y[i])
      if (cmp !== 0) return cmp
    }
    return x.length - y.length
  })

  return ordered.map((dir) => {
    const own = byDir[dir] ?? []
    const under = files.value.filter((f) => (dir === '' ? true : f.path.startsWith(`${dir}/`)))
    const known = under.filter((f) => f.addedLines !== null && f.removedLines !== null)
    return {
      dir,
      label: dir === '' ? '/' : (dir.split('/').at(-1) ?? dir),
      depth: dir === '' ? 0 : dir.split('/').length - 1,
      files: own,
      added: known.length === 0 ? null : known.reduce((n, f) => n + (f.addedLines ?? 0), 0),
      removed: known.length === 0 ? null : known.reduce((n, f) => n + (f.removedLines ?? 0), 0),
      total: under.length,
    }
  })
})

const visibleGroups = computed<DiffGroup[]>(() =>
  groups.value.filter((g) => {
    if (g.dir === '') return true
    const parts = g.dir.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (folded.value.has(parts.slice(0, i).join('/'))) return false
    }
    return true
  }),
)

const folded = ref(new Set<string>())

function toggleFolder(dir: string): void {
  const next = new Set(folded.value)
  if (!next.delete(dir)) next.add(dir)
  folded.value = next
}

function baseName(group: DiffGroup, path: string): string {
  return group.dir === '' ? path : path.slice(group.dir.length + 1)
}

const STATUS_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

function selectFile(path: string): void {
  void diff.selectFile(props.projectId, path)
}

function countLabel(added: number | null, removed: number | null): string {
  if (added === null || removed === null) return 'binary'
  return `+${added} −${removed}`
}

const keyedLines = computed(() =>
  (diff.fileDiff?.lines ?? []).map((line, i) => ({ line, i, key: `${i}:${line.type}:${line.text}` })),
)
</script>

<template>
  <div class="diff-view" data-testid="diff-view">
    <div v-if="notLive" class="diff-empty mono faint" data-testid="diff-not-live">
      Start a session for this project to review its changes.
    </div>
    <div v-else-if="result.gitNotice" class="diff-empty mono faint" data-testid="diff-git-notice">
      {{ result.gitNotice }}
    </div>
    <div v-else-if="files.length === 0" class="diff-empty mono faint" data-testid="diff-no-changes">
      No changes in the working tree.
    </div>
    <div v-else class="diff-body">
      <div class="diff-files" aria-label="Changed files" data-testid="diff-file-list">
        <div v-for="g in visibleGroups" :key="g.dir" class="diff-group">
          <button
            type="button"
            class="diff-folder"
            :style="{ paddingLeft: `${4 + g.depth * 12}px` }"
            :aria-expanded="!folded.has(g.dir)"
            :aria-label="`${g.dir || '/'}, ${g.total} ${g.total === 1 ? 'file' : 'files'}, ${countLabel(g.added, g.removed)}`"
            :data-testid="`diff-folder-${g.dir || 'root'}`"
            :title="g.dir || '/'"
            @click="toggleFolder(g.dir)"
          >
            <span class="dfo-caret" aria-hidden="true">
              <Icon :name="folded.has(g.dir) ? 'chevron-right' : 'chevron-down'" :size="12" />
            </span>
            <span class="dfo-path mono">{{ g.label }}</span>
            <span class="dfo-count mono" aria-hidden="true">{{ g.total }}</span>
            <span class="dfo-counts mono" aria-hidden="true">{{ countLabel(g.added, g.removed) }}</span>
          </button>
          <template v-if="!folded.has(g.dir)">
            <button
              v-for="f in g.files"
              :key="f.path"
              type="button"
              class="diff-file-row"
              :style="{ paddingLeft: `${10 + (g.depth + 1) * 12}px` }"
              :class="{ sel: diff.selectedPath === f.path }"
              :aria-pressed="diff.selectedPath === f.path"
              :aria-label="`${f.status} ${f.path}, ${countLabel(f.addedLines, f.removedLines)}`"
              :data-testid="`diff-file-${f.path}`"
              @click="selectFile(f.path)"
            >
              <span class="dfr-status" :class="f.status" aria-hidden="true">{{ STATUS_LETTER[f.status] }}</span>
              <span class="dfr-path mono" :title="f.path">{{ baseName(g, f.path) }}</span>
              <span class="dfr-counts mono" :class="{ binary: f.binary }" aria-hidden="true">
                {{ countLabel(f.addedLines, f.removedLines) }}
              </span>
            </button>
          </template>
        </div>
      </div>
      <div class="diff-pane" data-testid="diff-pane">
        <div v-if="!diff.selectedPath" class="diff-empty mono faint" data-testid="diff-pane-empty">
          Select a file to see its diff.
        </div>
        <div
          v-else-if="diff.fileLoading"
          class="diff-empty mono faint"
          role="status"
          data-testid="diff-pane-loading"
        >
          Loading…
        </div>
        <div v-else-if="!diff.fileDiff" class="diff-empty mono faint" data-testid="diff-pane-gone">
          This file no longer has a change to show.
        </div>
        <div v-else-if="diff.fileDiff.binary" class="diff-empty mono faint" data-testid="diff-pane-binary">
          No text diff is available for this file.
        </div>
        <div v-else class="diff-lines mono" data-testid="diff-pane-lines">
          <template v-for="row in keyedLines" :key="row.key">
          <button
            type="button"
            class="diff-line"
            :class="[row.line.type, { picked: isSelected(row.i) }]"
            :data-testid="`diff-line-${row.i}`"
            :aria-pressed="isSelected(row.i)"
            title="Click to comment on this line, shift-click to extend the selection"
            @click="pickLine(row.i, $event.shiftKey)"
          >
            <span class="dl-comment" aria-hidden="true">
              <Icon name="comment" :size="11" />
            </span>
            <span class="dl-marker" aria-hidden="true">{{
              row.line.type === 'add' ? '+' : row.line.type === 'del' ? '-' : ' '
            }}</span>
            <span class="dl-text">{{ row.line.text }}</span>
          </button>

          <div
            v-if="range && row.i === range[1]"
            class="dl-composer"
            data-testid="diff-comment"
          >
          <div class="dlc-head mono">
            <span data-testid="diff-comment-count">
              {{ selectedLines.length }} line{{ selectedLines.length === 1 ? '' : 's' }} selected
            </span>
            <button
              type="button"
              class="dlc-x"
              data-testid="diff-comment-cancel"
              title="Discard this comment"
              @click="clearSelection()"
            >
              <Icon name="close" :size="11" />
            </button>
          </div>
          <textarea
            ref="composer"
            v-model="instruction"
            class="dlc-input mono"
            data-testid="diff-comment-input"
            rows="2"
            placeholder="What should change here? Enter to send, Shift+Enter for a new line"
            @keydown.enter.exact.prevent="sendInstruction()"
            @keydown.esc="clearSelection()"
          ></textarea>
          <div v-if="diff.applyError" class="dlc-err" data-testid="diff-comment-error">
            {{ diff.applyError }}
          </div>
          <div class="dlc-foot">
            <span class="dlc-note mono">applied by a container session</span>
            <button
              type="button"
              class="dlc-send"
              data-testid="diff-comment-send"
              :disabled="diff.applying || !instruction.trim()"
              @click="sendInstruction()"
            >
              {{ diff.applying ? 'Sending…' : 'Apply' }}
            </button>
          </div>
          </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-view {
  flex: 1;
  display: flex;
  min-height: 0;
}

.diff-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 22px;
  font-size: var(--fs-ui);
  text-align: center;
}

.diff-body {
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
}

.diff-files {
  width: 280px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.diff-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.diff-group + .diff-group {
  margin-top: 8px;
}

.diff-folder {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--rc);
  background: transparent;
  border-bottom: 1px solid var(--border-soft);
  text-align: left;
  cursor: pointer;
}

.diff-folder:hover {
  background: var(--bg-hover);
}

.diff-folder:focus-visible {
  outline: 1px solid var(--green);
  outline-offset: -1px;
}

.dfo-caret {
  flex-shrink: 0;
  display: inline-flex;
  color: var(--text-faint);
}

.dfo-path {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  color: var(--text-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dfo-count {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

.dfo-counts {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.diff-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin-left: 8px;
  border-radius: var(--rc);
  text-align: left;
  cursor: pointer;
}

.diff-file-row:hover {
  background: var(--bg-hover);
}

.diff-file-row.sel {
  background: color-mix(in srgb, var(--green) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--green) 35%, transparent);
}

.dfr-status {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: var(--fs-micro);
  font-weight: var(--w-em);
  color: var(--text-faint);
}

.dfr-status.untracked,
.dfr-status.added {
  color: var(--green);
}

.dfr-status.deleted {
  color: var(--red);
}

.dfr-status.renamed,
.dfr-status.modified {
  color: var(--amber);
}

.dfr-path {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dfr-counts {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
}

.dfr-counts.binary {
  font-style: italic;
}

.diff-pane {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.diff-lines {
  padding: 6px 0;
}

.diff-line {
  display: flex;
  width: 100%;
  padding: 0 14px;
  font-size: var(--fs-meta);
  line-height: 1.55;
  white-space: pre-wrap;
  text-align: left;
  background: none;
  border: 0;
  cursor: text;
}

.diff-line:hover {
  box-shadow: inset 1px 0 0 var(--border-strong);
}

.diff-line:hover .dl-comment {
  opacity: 1;
}

.diff-line.picked {
  background: color-mix(in srgb, var(--teal) 14%, transparent);
  box-shadow: inset 1px 0 0 var(--teal);
}

.dl-comment {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  width: 15px;
  margin-left: -4px;
  color: var(--text-meta);
  opacity: 0;
  transition: opacity 90ms var(--ease);
}

.diff-line.picked .dl-comment {
  color: var(--teal);
  opacity: 1;
}

.diff-line:focus-visible .dl-comment {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .dl-comment {
    transition: none;
  }
}

.dl-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(520px, calc(100% - 28px));
  margin: 4px 14px 10px;
  padding: 8px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  box-shadow: var(--shadow-dd);
}

.dlc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.dlc-x {
  display: inline-flex;
  padding: 2px;
  color: var(--text-faint);
  background: none;
  border: 0;
  cursor: pointer;
}

.dlc-x:hover {
  color: var(--text);
}

.dlc-input {
  width: 100%;
  padding: 6px 8px;
  font-size: var(--fs-meta);
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--rp);
  resize: vertical;
}

.dlc-input:focus {
  outline: none;
  border-color: var(--green);
}

.dlc-err {
  font-size: var(--fs-micro);
  color: var(--red);
}

.dlc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dlc-note {
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

.dlc-send {
  padding: 4px 12px;
  font-size: var(--fs-meta);
  color: var(--green);
  background: color-mix(in srgb, var(--green) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--green) 50%, transparent);
  border-radius: var(--rc);
  cursor: pointer;
}

.dlc-send:disabled {
  color: var(--text-ghost);
  background: none;
  border-color: var(--border);
  cursor: not-allowed;
}

.diff-line.add {
  background: color-mix(in srgb, var(--green) 8%, transparent);
  color: var(--text-body);
}

.diff-line.del {
  background: color-mix(in srgb, var(--red) 8%, transparent);
  color: var(--text-body);
}

.diff-line.context {
  color: var(--text-mid);
}

.dl-marker {
  flex-shrink: 0;
  width: 16px;
  color: var(--text-faint);
}

.diff-line.add .dl-marker {
  color: var(--green);
}

.diff-line.del .dl-marker {
  color: var(--red);
}

.dl-text {
  flex: 1;
  min-width: 0;
}
</style>
