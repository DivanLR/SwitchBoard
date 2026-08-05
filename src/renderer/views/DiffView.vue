<script setup lang="ts">
// Diff tab: the project's uncommitted working-tree changes, tracked and
// untracked alike, with one file's diff shown on selection. Read-only
// (spec.md FR-010): no stage, discard, or revert action ships here.
import { computed } from 'vue'
import { useDiffStore } from '@renderer/stores/diff'

const props = defineProps<{ projectId: string }>()
const diff = useDiffStore()

const result = computed(() => diff.resultFor(props.projectId))
const notLive = computed(() => diff.isNotLive(props.projectId))
const files = computed(() => result.value.files)

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
        <button
          v-for="f in files"
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
          <span class="dfr-path mono">{{ f.path }}</span>
          <span class="dfr-counts mono" :class="{ binary: f.binary }" aria-hidden="true">
            {{ countLabel(f.addedLines, f.removedLines) }}
          </span>
        </button>
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
  font-size: 12px;
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

.diff-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--rp);
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
  font-size: 10.5px;
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
  font-size: 11.5px;
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dfr-counts {
  flex-shrink: 0;
  font-size: 10.5px;
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
  font-size: 11.5px;
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
