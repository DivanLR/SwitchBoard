<script setup lang="ts">
// Diff tab: the project's uncommitted working-tree changes, tracked and
// untracked alike, with one file's diff shown on selection. Read-only
// (spec.md FR-010): no stage, discard, or revert action ships here.
import { computed, ref } from 'vue'
import type { DiffFileEntry } from '@shared/domain'
import { useDiffStore } from '@renderer/stores/diff'

const props = defineProps<{ projectId: string }>()
const diff = useDiffStore()

const result = computed(() => diff.resultFor(props.projectId))
const notLive = computed(() => diff.isNotLive(props.projectId))
const files = computed(() => result.value.files)

/** The folder a run of changed files shares, with its own totals. */
interface DiffGroup {
  /** Project-relative directory, '' for the project root. */
  dir: string
  label: string
  files: DiffFileEntry[]
  /** Sum of the files whose counts are known; null when none are. */
  added: number | null
  removed: number | null
}

/**
 * Changed files grouped by the folder holding them, because a flat list stops being
 * readable at about a screenful and a working tree in the middle of a refactor is
 * mostly one folder repeated. The path is already project-relative with forward
 * slashes (DiffFileEntry.path), so this is a renderer-side regroup of what diff.list
 * already returns rather than a second query.
 *
 * Root-level files lead, then folders alphabetically: the root is where a project's
 * loudest files live (package.json, a config, a lockfile) and burying them under the
 * alphabet would hide exactly the changes worth noticing first.
 */
const groups = computed<DiffGroup[]>(() => {
  const byDir = new Map<string, DiffFileEntry[]>()
  for (const file of files.value) {
    const cut = file.path.lastIndexOf('/')
    const dir = cut === -1 ? '' : file.path.slice(0, cut)
    const existing = byDir.get(dir)
    if (existing) existing.push(file)
    else byDir.set(dir, [file])
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([dir, entries]) => {
      const known = entries.filter((f) => f.addedLines !== null && f.removedLines !== null)
      return {
        dir,
        label: dir === '' ? '/' : dir,
        files: entries,
        added: known.length === 0 ? null : known.reduce((n, f) => n + (f.addedLines ?? 0), 0),
        removed: known.length === 0 ? null : known.reduce((n, f) => n + (f.removedLines ?? 0), 0),
      }
    })
})

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
        <!-- One block per folder. The heading carries the folder's path and its own
             totals, so a folded folder still reports how much changed inside it —
             the point of folding is to stop reading a folder, not to lose it. Files
             below show only their own name, since the heading already said where
             they are. -->
        <div v-for="g in groups" :key="g.dir" class="diff-group">
          <button
            type="button"
            class="diff-folder"
            :aria-expanded="!folded.has(g.dir)"
            :aria-label="`${g.label}, ${g.files.length} ${g.files.length === 1 ? 'file' : 'files'}, ${countLabel(g.added, g.removed)}`"
            :data-testid="`diff-folder-${g.dir || 'root'}`"
            :title="g.label"
            @click="toggleFolder(g.dir)"
          >
            <span class="dfo-caret mono" aria-hidden="true">{{ folded.has(g.dir) ? '▶' : '▼' }}</span>
            <span class="dfo-path mono">{{ g.label }}</span>
            <span class="dfo-count mono" aria-hidden="true">{{ g.files.length }}</span>
            <span class="dfo-counts mono" aria-hidden="true">{{ countLabel(g.added, g.removed) }}</span>
          </button>
          <template v-if="!folded.has(g.dir)">
            <button
              v-for="f in g.files"
              :key="f.path"
              type="button"
              class="diff-file-row"
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
          <div v-for="(line, i) in diff.fileDiff.lines" :key="i" class="diff-line" :class="line.type">
            <span class="dl-marker" aria-hidden="true">{{
              line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
            }}</span>
            <span class="dl-text">{{ line.text }}</span>
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
  width: 8px;
  font-size: 8px;
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
  font-weight: 600;
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
  padding: 0 14px;
  font-size: var(--fs-meta);
  line-height: 1.55;
  white-space: pre-wrap;
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
