<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SpecDetail, SpecStatus, SpecSummary } from '@shared/domain'
import { SPEC_KIT_COMMANDS, type SddCommand } from '@shared/sdd'
import MarkdownText from '@renderer/components/MarkdownText.vue'
import Icon from '@renderer/components/Icon.vue'
import SddCommands from '@renderer/components/sdd/SddCommands.vue'

const props = defineProps<{
  specs: SpecSummary[]
  detail: SpecDetail | null
  selectedId: string | null
  busy: readonly string[]
}>()
const emit = defineEmits<{
  (e: 'select', specId: string): void
  (e: 'run', command: SddCommand): void
  (e: 'set-target', label: string): void
  (e: 'open-flow', specId: string): void
}>()

type Part = 'spec' | 'plan' | 'tasks' | 'clarify' | 'commands'

const PARTS: readonly { id: Part; label: string }[] = [
  { id: 'spec', label: 'spec.md' },
  { id: 'plan', label: 'plan.md' },
  { id: 'tasks', label: 'tasks.md' },
  { id: 'clarify', label: 'Clarify' },
  { id: 'commands', label: 'Commands' },
]

const STATUS_LABEL: Record<SpecStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  in_progress: 'Implementing',
  complete: 'Done',
}

const part = ref<Part>('tasks')
watch(
  () => props.detail?.id,
  () => {
    part.value = 'tasks'
  },
)

const specify = SPEC_KIT_COMMANDS.find((c) => c.command === 'speckit-specify') as SddCommand
const sections = computed(() => (part.value === 'plan' ? props.detail?.plan : props.detail?.sections) ?? [])
const openQs = computed(() => (props.detail?.clarifications ?? []).map((q, at) => ({ id: `Q${at + 1}`, q })))
const progress = computed(() =>
  props.detail && props.detail.tasksTotal > 0 ? props.detail.tasksDone / props.detail.tasksTotal : 0,
)
const converge = computed(() => {
  const c = props.detail?.convergence
  if (!c || c.rounds === 0) return 'Not converged yet'
  const rounds = `${c.rounds} convergence round${c.rounds === 1 ? '' : 's'}`
  return c.open > 0 ? `${rounds}, ${c.open} task${c.open === 1 ? '' : 's'} open` : `${rounds}, all built`
})
</script>

<template>
  <div class="sdd-features" data-testid="sdd-features">
    <div class="ui-toolbar sdf-chips">
      <button
        v-for="s in specs"
        :key="s.id"
        type="button"
        class="ui-chip mono"
        :class="{ 'is-on': s.id === selectedId }"
        :data-testid="`spec-chip-${s.id}`"
        @click="emit('select', s.id)"
      >
        {{ s.id }}
      </button>
      <button
        type="button"
        class="ui-chip sdf-new"
        data-testid="spec-new"
        :disabled="busy.includes(specify.command)"
        @click="emit('run', specify)"
      >
        <Icon name="plus" :size="11" /> New spec
      </button>
    </div>

    <div v-if="specs.length === 0" class="ui-empty-line" data-testid="specs-empty">
      No specs in this project yet. New spec runs /speckit-specify on your description.
    </div>

    <template v-else-if="detail">
      <div class="ui-card sdf-head">
        <div class="sdf-line">
          <span class="sdf-title">{{ detail.title }}</span>
          <span class="ui-chip" :class="{ 'is-on': detail.status === 'complete' }" data-testid="spec-status">
            {{ STATUS_LABEL[detail.status] }}
          </span>
          <span class="spacer"></span>
          <span class="ui-meta mono">{{ detail.path }}/</span>
          <button type="button" class="btn-outline" data-testid="sdd-open-flow" @click="emit('open-flow', detail.id)">
            Open in Flow
          </button>
        </div>
        <div v-if="detail.description" class="sdf-desc">{{ detail.description }}</div>
        <div class="sdf-progress">
          <div class="sdf-bar"><div class="sdf-fill" :style="{ transform: `scaleX(${progress})` }"></div></div>
          <span class="ui-meta mono" data-testid="spec-progress">{{ detail.tasksDone }}/{{ detail.tasksTotal }} tasks</span>
          <span class="ui-chip" data-testid="spec-converge">{{ converge }}</span>
        </div>
      </div>

      <div class="ui-tabs" role="tablist" aria-label="Spec parts">
        <button
          v-for="p in PARTS"
          :key="p.id"
          type="button"
          role="tab"
          class="ui-tab"
          :class="{ 'is-selected': part === p.id }"
          :aria-selected="part === p.id"
          :data-testid="`part-${p.id}`"
          @click="part = p.id"
        >
          {{ p.label }}
          <span v-if="p.id === 'clarify' && openQs.length > 0" class="badge-count">{{ openQs.length }}</span>
        </button>
      </div>

      <div v-if="part === 'spec' || part === 'plan'" class="sdf-sections" data-testid="spec-sections">
        <div v-if="sections.length === 0" class="ui-empty-line">No {{ part }}.md yet.</div>
        <div v-for="sec in sections" :key="sec.title" class="ui-card">
          <div class="sdf-sec-head">
            <span class="mono sdf-sec-title">## {{ sec.title }}</span>
            <button
              type="button"
              class="btn-quiet sdf-refine"
              :data-testid="`refine-${sec.title}`"
              @click="emit('set-target', `${detail.id}/${part}.md · ${sec.title}`)"
            >
              <Icon name="pencil" :size="11" /> Refine
            </button>
          </div>
          <MarkdownText class="sdf-body" :text="sec.body" />
        </div>
      </div>

      <div v-else-if="part === 'tasks'" data-testid="spec-tasks">
        <div v-if="detail.phases.length === 0" class="ui-empty-line">No tasks.md yet. Run /speckit-tasks.</div>
        <div v-for="phase in detail.phases" :key="phase.label" class="sdf-phase">
          <div class="sdf-phase-head">
            <span class="sdf-phase-label">{{ phase.label }}</span>
            <span class="ui-meta mono">{{ phase.tasks.filter((t) => t.done).length }}/{{ phase.tasks.length }}</span>
          </div>
          <div
            v-for="task in phase.tasks"
            :key="phase.label + task.id + task.label"
            class="ui-row sdf-task"
            :data-testid="task.done ? 'task-done' : 'task-todo'"
          >
            <Icon :name="task.done ? 'check' : 'square'" :size="11" class="sdf-task-mark" :class="{ done: task.done }" />
            <span class="mono ui-meta">{{ task.id }}</span>
            <span class="sdf-task-label" :class="{ done: task.done }">{{ task.label }}</span>
            <button
              type="button"
              class="btn-quiet sdf-refine"
              :data-testid="`task-refine-${task.id || task.label}`"
              :aria-label="`Edit task ${task.id || task.label}`"
              @click="emit('set-target', `${detail.id}/tasks.md · ${task.id || task.label}`)"
            >
              <Icon name="pencil" :size="11" />
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="part === 'clarify'" class="sdf-sections" data-testid="spec-clarify">
        <div v-if="openQs.length === 0 && detail.resolvedClarifications.length === 0" class="ui-empty-line">
          No clarifications: the spec has no [NEEDS CLARIFICATION] markers.
        </div>
        <div v-for="qq in openQs" :key="qq.id" class="ui-card is-warn sdf-q">
          <span class="mono ui-meta">{{ qq.id }} · NEEDS CLARIFICATION</span>
          <span class="sdf-q-text">{{ qq.q }}</span>
          <button
            type="button"
            class="btn-quiet sdf-refine"
            :data-testid="`answer-${qq.id}`"
            @click="emit('set-target', `${detail.id}/clarify · ${qq.id}`)"
          >
            <Icon name="pencil" :size="11" /> Answer in my own words
          </button>
        </div>
        <div
          v-for="c in detail.resolvedClarifications"
          :key="`${c.question}:${c.answer}`"
          class="ui-card sdf-q"
          data-testid="resolved-clarification"
        >
          <span class="sdf-q-text dim">{{ c.question }}</span>
          <span class="sdf-q-answer"><Icon name="check" :size="11" /> {{ c.answer }}</span>
        </div>
      </div>

      <SddCommands
        v-else
        :commands="SPEC_KIT_COMMANDS"
        :target="detail.id"
        :busy="busy"
        @run="(c) => emit('run', c)"
      />
    </template>
  </div>
</template>

<style scoped>
.sdd-features {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.sdf-chips {
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.sdf-new {
  border-style: dashed;
  background: transparent;
  cursor: pointer;
}

.sdf-head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.sdf-line {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.sdf-title {
  font: var(--w-em) var(--fs-title) / 1.3 var(--sans);
  color: var(--text-bright);
}

.sdf-desc,
.sdf-body,
.sdf-q-text {
  max-width: 78ch;
  font-size: var(--fs-ui);
  line-height: 1.5;
  color: var(--text-body);
}

.sdf-progress {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.sdf-bar {
  flex: 1;
  height: 6px;
  background: var(--surface-inset);
  overflow: hidden;
}

.sdf-fill {
  height: 100%;
  background: var(--green);
  transform-origin: left;
}

.sdf-sections {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.sdf-sec-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-2);
}

.sdf-sec-title {
  flex: 1;
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.sdf-refine {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  padding: 2px 8px;
}

.sdf-phase {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--sp-4);
}

.sdf-phase-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding-bottom: var(--sp-1);
  border-bottom: 1px solid var(--border-soft);
}

.sdf-phase-label {
  flex: 1;
  font: var(--w-em) var(--fs-ui) / 1.3 var(--sans);
  color: var(--text-strong);
}

.sdf-task {
  gap: var(--sp-2);
}

.sdf-task-mark {
  flex-shrink: 0;
  color: var(--text-faint);
}

.sdf-task-mark.done {
  color: var(--green);
}

.sdf-task-label {
  flex: 1;
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.sdf-task-label.done {
  color: var(--text-faint);
  text-decoration: line-through;
}

.sdf-q {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
}

.sdf-q-answer {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  color: var(--green);
}
</style>
