<script setup lang="ts">
import { computed } from 'vue'
import type { SddEntry, SddProcess } from '@shared/domain'
import { SDD_COMMANDS, SDD_REPORTS, type SddCommand } from '@shared/sdd'
import MarkdownText from '@renderer/components/MarkdownText.vue'
import Icon from '@renderer/components/Icon.vue'
import SddCommands from '@renderer/components/sdd/SddCommands.vue'

const props = defineProps<{
  process: SddProcess
  entries: SddEntry[]
  installed: boolean
  selectedSlug: string | null
  report: { slug: string; file: string; path: string | null; content: string | null } | null
  busy: readonly string[]
  installing: boolean
  installError: string | null
}>()
const emit = defineEmits<{
  (e: 'install'): void
  (e: 'select', slug: string): void
  (e: 'open-report', slug: string, file: string): void
  (e: 'run', command: SddCommand): void
  (e: 'open-flow', entry: SddEntry): void
}>()

const NOUN: Record<SddProcess, { one: string; many: string; empty: string }> = {
  bug: { one: 'bug', many: 'Bugs', empty: 'No bugs assessed yet. New bug runs /speckit-bug-assess on the symptom.' },
  assess: { one: 'idea', many: 'Ideas', empty: 'No ideas assessed yet. New idea runs /speckit-assess-intake on it.' },
}

const VERDICT_CLASS: Record<string, string> = {
  verified: 'is-on',
  go: 'is-on',
  partial: 'is-warn',
  'needs-clarification': 'is-warn',
  failed: 'is-danger',
}

const commands = computed(() => SDD_COMMANDS[props.process])
const reports = computed(() => SDD_REPORTS[props.process])
const selected = computed(() => props.entries.find((entry) => entry.slug === props.selectedSlug) ?? null)
const shown = computed(() => (props.report && props.report.slug === props.selectedSlug ? props.report : null))
const noun = computed(() => NOUN[props.process])

function verdictText(entry: SddEntry): string {
  if (entry.verdict) return entry.verdict
  return props.process === 'bug' ? 'not verified' : 'undecided'
}
</script>

<template>
  <div class="sdd-process" :data-testid="`sdd-${process}`">
    <div v-if="!installed" class="ui-card sdp-install" :data-testid="`sdd-missing-${process}`">
      <div class="sdp-install-text">
        The {{ process }} extension is not installed in this project, so the {{ noun.one }} commands do not exist
        here yet. Installing runs <span class="mono">specify extension add {{ process }}</span> in the project
        folder.
      </div>
      <button
        type="button"
        class="btn-solid"
        :data-testid="`sdd-install-${process}`"
        :disabled="installing"
        @click="emit('install')"
      >
        {{ installing ? 'Installing…' : `Install the ${process} extension` }}
      </button>
      <div v-if="installError" class="ui-err" role="alert" :data-testid="`sdd-install-error-${process}`">
        {{ installError }}
      </div>
    </div>

    <template v-else>
      <div class="ui-toolbar sdp-bar">
        <span class="ui-kicker">{{ noun.many }}</span>
        <span class="spacer"></span>
        <button
          type="button"
          class="btn-outline"
          :data-testid="`sdd-new-${process}`"
          :disabled="busy.includes(commands[0].command)"
          @click="emit('run', commands[0])"
        >
          <Icon name="plus" :size="11" /> New {{ noun.one }}
        </button>
      </div>

      <div v-if="entries.length === 0" class="ui-empty-line" :data-testid="`sdd-empty-${process}`">{{ noun.empty }}</div>

      <div v-else class="sdp-cols">
        <div class="sdp-list" role="listbox" :aria-label="noun.many">
          <button
            v-for="entry in entries"
            :key="entry.slug"
            type="button"
            role="option"
            class="ui-row sdp-row"
            :class="{ 'is-selected': entry.slug === selectedSlug }"
            :aria-selected="entry.slug === selectedSlug"
            :data-testid="`sdd-entry-${entry.slug}`"
            @click="emit('select', entry.slug)"
          >
            <span class="sdp-row-title">{{ entry.title }}</span>
            <span class="sdp-row-meta">
              <span class="mono ui-meta">{{ entry.slug }}</span>
              <span v-if="entry.severity" class="ui-chip">{{ entry.severity }}</span>
              <span class="ui-chip" :class="VERDICT_CLASS[entry.verdict ?? '']">{{ verdictText(entry) }}</span>
            </span>
          </button>
        </div>

        <div v-if="selected" class="sdp-detail" :data-testid="`sdd-detail-${process}`">
          <div class="sdp-detail-head">
            <span class="sdp-title">{{ selected.title }}</span>
            <span
              class="ui-chip"
              :class="VERDICT_CLASS[selected.verdict ?? '']"
              data-testid="sdd-verdict"
              >{{ verdictText(selected) }}</span
            >
            <span class="spacer"></span>
            <button type="button" class="btn-outline" data-testid="sdd-open-flow" @click="emit('open-flow', selected)">
              Open in Flow
            </button>
          </div>
          <div class="ui-tabs" role="tablist" aria-label="Reports">
            <button
              v-for="r in reports"
              :key="r.file"
              type="button"
              role="tab"
              class="ui-tab"
              :class="{ 'is-selected': shown?.file === r.file }"
              :aria-selected="shown?.file === r.file"
              :disabled="!selected.files.includes(r.file)"
              :data-testid="`sdd-report-${r.file}`"
              @click="emit('open-report', selected.slug, r.file)"
            >
              {{ r.label }}
            </button>
          </div>
          <MarkdownText
            v-if="shown?.content"
            class="sdp-doc"
            :text="shown.content"
            data-testid="sdd-report-content"
          />
          <div v-else class="ui-empty-line">No report written yet.</div>
        </div>
      </div>

      <SddCommands :commands="commands" :target="selectedSlug" :busy="busy" @run="(c) => emit('run', c)" />
    </template>
  </div>
</template>

<style scoped>
.sdd-process {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.sdp-install {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-3);
  max-width: 720px;
}

.sdp-install-text {
  font-size: var(--fs-ui);
  line-height: 1.5;
  color: var(--text-body);
}

.sdp-cols {
  display: flex;
  gap: var(--sp-5);
  min-height: 0;
}

.sdp-list {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 520px;
  overflow-y: auto;
}

.sdp-row {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-1);
  padding: var(--sp-3);
}

.sdp-row-title {
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.sdp-row-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.sdp-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.sdp-detail-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.sdp-title {
  font: var(--w-em) var(--fs-title) / 1.3 var(--sans);
  color: var(--text-bright);
}

.sdp-doc {
  max-height: 520px;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border-soft);
}
</style>
