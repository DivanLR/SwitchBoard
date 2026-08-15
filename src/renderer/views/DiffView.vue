<script setup lang="ts">
// Diff tab: the project's uncommitted working-tree changes, tracked and
// untracked alike, with one file's diff shown on selection. Read-only
// (spec.md FR-010): no stage, discard, or revert action ships here.
import { computed, nextTick, ref, watch } from 'vue'
import type { DiffFileEntry } from '@shared/domain'
import { useDiffStore } from '@renderer/stores/diff'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ projectId: string }>()
const diff = useDiffStore()

// --- Commenting on a region ---
//
// The model is a pull-request comment: point at a line, or drag a few, and say
// what should be different. The difference is that it is carried out rather than
// recorded — the instruction goes to the section's containerised session, which
// has the working tree bind-mounted, so the edit shows up in this same diff.
//
// This is the one thing in this tab that writes. It is not a stage, discard or
// revert action (FR-010 rules those out and they stay out): those change the
// repository behind the developer's back, whereas this asks for an edit the same
// way the conversation does, and shows it as a diff to be read afterwards.
const anchor = ref<number | null>(null)
const head = ref<number | null>(null)
const instruction = ref('')
const composer = ref<HTMLTextAreaElement | null>(null)

/** Selected range as [first, last], normalised so a drag upwards still works. */
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

/**
 * Click selects one line; shift-click extends from the line already anchored.
 *
 * Shift-to-extend rather than click-and-drag: a drag over a scrolling code pane
 * fights the scroll, and the diff is read with the keyboard hand free anyway.
 */
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

// A new file's lines have nothing to do with the old file's indices.
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
  // The selection is cleared only on success: a failure leaves the region and the
  // words intact, because the fix is usually to start a session and press again.
  if (sent) clearSelection()
}

const result = computed(() => diff.resultFor(props.projectId))
const notLive = computed(() => diff.isNotLive(props.projectId))
const files = computed(() => result.value.files)

/** One folder in the tree, with the files directly inside it and its own totals. */
interface DiffGroup {
  /** Project-relative directory, '' for the project root. */
  dir: string
  /** The last segment only: the tree's indentation already says where it sits. */
  label: string
  /** How deep to indent it. 0 for the root and for a top-level folder. */
  depth: number
  files: DiffFileEntry[]
  /** Sum over this folder AND everything under it, so a folded parent still
   *  reports what changed inside. Null when no file below it has known counts. */
  added: number | null
  removed: number | null
  /** Files in this folder and every folder under it, for the heading's count. */
  total: number
}

/**
 * Changed files grouped by folder — a flat list stops being readable at a
 * screenful, and a refactor's working tree is mostly one folder repeated. A
 * renderer-side regroup of what diff.list already returns, not a second query.
 *
 * Root-level files lead, then folders alphabetically: the root holds a
 * project's loudest files (package.json, a config, a lockfile), and
 * alphabetical order would bury exactly the changes worth noticing first.
 */
const groups = computed<DiffGroup[]>(() => {
  const byDir = Object.groupBy(files.value, (file) => {
    const cut = file.path.lastIndexOf('/')
    return cut === -1 ? '' : file.path.slice(0, cut)
  })

  // Every ancestor, not only the folders that directly hold a changed file. A
  // repository whose changes are all in src/main/sessions/ has nothing directly
  // in src/, so grouping by immediate parent alone produced one row labelled
  // with the whole path and no src/ to fold. The tree is the point: a folder
  // with one child folder and nothing else still gets a row.
  const dirs = new Set<string>()
  for (const dir of Object.keys(byDir)) {
    dirs.add(dir)
    const parts = dir === '' ? [] : dir.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }

  // Segment-wise, so a parent always sorts immediately before its own children
  // and never lands after a sibling that merely shares a prefix ('src-gen'
  // sorting between 'src' and 'src/main' would break the indentation).
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
    // Object.groupBy types every value as possibly absent, because the key type
    // is wider than the keys it actually produced.
    const own = byDir[dir] ?? []
    // Totals cover the whole subtree, so folding a parent hides the detail
    // without hiding how much changed under it.
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

/**
 * The rows actually drawn: a folder disappears when any folder ABOVE it is
 * folded, which is what makes folding a parent fold its whole subtree rather
 * than only the files sitting directly in it.
 */
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

/**
 * Folded folders, by directory. Local and unpersisted on purpose: which folders you
 * have collapsed is a reading position in one working tree, and a working tree is
 * gone by the next commit.
 */
const folded = ref(new Set<string>())

function toggleFolder(dir: string): void {
  // A new Set, not a mutation: Vue's reactivity tracks Set operations, but replacing
  // it keeps this readable next to the computed above and costs nothing at this size.
  const next = new Set(folded.value)
  if (!next.delete(dir)) next.add(dir)
  folded.value = next
}

/** The file's own name; its folder is already named by the heading above it. */
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

/** "+3 −1", or "binary" when counts are unavailable rather than a
 *  fabricated 0/0 (FR-011). */
function countLabel(added: number | null, removed: number | null): string {
  if (added === null || removed === null) return 'binary'
  return `+${added} −${removed}`
}
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
        <!-- One block per folder. The heading carries its own totals, so folding it
             still reports how much changed inside — folding stops you reading it,
             not losing it. Files below show only their own name; the heading
             already said where they are. -->
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
          <!-- A line is a button because it does something: it selects a region to
               comment on. Shift-click extends, which is why the title says so —
               nothing else on screen could tell you that. -->
          <button
            v-for="(line, i) in diff.fileDiff.lines"
            :key="i"
            type="button"
            class="diff-line"
            :class="[line.type, { picked: isSelected(i) }]"
            :data-testid="`diff-line-${i}`"
            :aria-pressed="isSelected(i)"
            title="Click to comment on this line, shift-click to extend the selection"
            @click="pickLine(i, $event.shiftKey)"
          >
            <span class="dl-marker" aria-hidden="true">{{
              line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
            }}</span>
            <span class="dl-text">{{ line.text }}</span>
          </button>
        </div>

        <!-- Anchored to the pane rather than to the line, deliberately: a panel
             wedged between two lines pushes the code around as it grows, and the
             region it refers to is already marked. -->
        <div v-if="range" class="dl-composer" data-testid="diff-comment">
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
            <!-- Says where it goes. An edit arriving in the working tree from a
                 session the developer never opened is alarming if unannounced. -->
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

/* One folder and the files in it, kept together so the gap between groups reads as
   the boundary rather than the row spacing doing double duty. */
.diff-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.diff-group + .diff-group {
  margin-top: 8px;
}

/* The folder heading. A control, because it folds — and the one place in this list
   where the path is the subject rather than a file's address. */
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

/* Files sit in from their folder's heading, so the nesting is readable without a
   rule or a guide line. */
.diff-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin-left: 8px;
  /* --rc, the content radius: a row is a container, not a tag reporting a figure.
     Both resolve to 0px, so this is a correctness fix rather than a visual one. */
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
  /* It is a button now, and a button that must still read as a line of code:
     no border, no radius, and the text stays left. */
  text-align: left;
  background: none;
  border: 0;
  cursor: text;
}

.diff-line:hover {
  box-shadow: inset 2px 0 0 var(--border-strong);
}

/* The selected region. A left bar rather than a wash, so the add/del tint that
   says what KIND of line it is survives underneath. */
.diff-line.picked {
  background: color-mix(in srgb, var(--teal) 14%, transparent);
  box-shadow: inset 2px 0 0 var(--teal);
}

.dl-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 14px 14px;
  padding: 8px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
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
