<script setup lang="ts">
// Per-project specs view backed by GitHub Spec Kit — 1:1 with the design:
// spec chips, a spec card with status + progress, and part tabs (spec / clarify
// / tasks). When Spec Kit is not installed, an install button scaffolds it
// per-project (ephemeral uvx; nothing global).
import { computed, ref, watch } from 'vue'
import type { SpecStatus } from '@shared/domain'
import { useSpecsStore } from '@renderer/stores/specs'

const props = defineProps<{ projectId: string }>()
const specs = useSpecsStore()

type Part = 'spec' | 'clarify' | 'tasks'
const part = ref<Part>('tasks')

watch(
  () => props.projectId,
  (projectId) => {
    void specs.loadState(projectId)
  },
  { immediate: true },
)

const state = computed(() => specs.stateFor(props.projectId))
const detail = computed(() => specs.detail)

const statusLabel: Record<SpecStatus, string> = {
  draft: 'draft',
  in_progress: 'in progress',
  complete: 'complete',
}

const progressPct = computed(() => {
  const d = detail.value
  if (!d || d.tasksTotal === 0) return 0
  return Math.round((d.tasksDone / d.tasksTotal) * 100)
})

function statusDot(status: SpecStatus): string {
  return status === 'complete'
    ? 'var(--green)'
    : status === 'in_progress'
      ? 'var(--blue)'
      : 'var(--text-faint)'
}
</script>

<template>
  <div class="specs" data-testid="specs-view">
    <!-- Not installed: offer per-project install -->
    <div v-if="!state.installed" class="not-installed" data-testid="specs-not-installed">
      <div class="ni-icon mono">◇</div>
      <div class="ni-title">Spec Kit is not set up in this project</div>
      <div class="ni-sub">
        GitHub Spec Kit adds a spec-driven workflow (<span class="mono">/specify</span>,
        <span class="mono">/plan</span>, <span class="mono">/tasks</span>,
        <span class="mono">/implement</span>). It installs into this project only — nothing global.
      </div>
      <button
        class="btn-solid ni-btn"
        data-testid="specs-install"
        :disabled="specs.installing"
        @click="specs.install(props.projectId)"
      >
        {{ specs.installing ? 'installing…' : 'install spec kit in this project' }}
      </button>
      <div v-if="specs.installError" class="ni-error mono" data-testid="specs-install-error">
        {{ specs.installError }}
      </div>
    </div>

    <!-- Installed but no specs yet -->
    <div v-else-if="state.specs.length === 0" class="not-installed" data-testid="specs-empty">
      <div class="ni-icon mono">◇</div>
      <div class="ni-title">No specs in this project</div>
      <div class="ni-sub">
        Run <span class="mono">/specify</span> in the session to scaffold one with spec-kit.
      </div>
    </div>

    <!-- Specs present -->
    <div v-else class="has-specs">
      <!-- Spec chips -->
      <div class="chips">
        <button
          v-for="s in state.specs"
          :key="s.id"
          class="chip mono"
          :class="{ sel: s.id === specs.selectedSpecId }"
          :data-testid="`spec-chip-${s.id}`"
          @click="specs.selectSpec(props.projectId, s.id)"
        >
          <span class="dot" :style="{ background: statusDot(s.status) }"></span>{{ s.id }}
        </button>
      </div>

      <template v-if="detail">
        <!-- Spec card -->
        <div class="card spec-card">
          <div class="sc-head">
            <span class="sc-title mono">{{ detail.title }}</span>
            <span class="sc-status mono" :class="detail.status">{{ statusLabel[detail.status] }}</span>
            <span style="flex: 1"></span>
            <span class="sc-path mono">{{ detail.path }}</span>
          </div>
          <div v-if="detail.description" class="sc-desc">{{ detail.description }}</div>
          <div class="sc-progress-row mono">
            <span v-if="detail.status === 'complete'" style="color: var(--green)"
              >✓ all tasks complete</span
            >
            <span class="sc-progress-label">{{ detail.tasksDone }}/{{ detail.tasksTotal }} tasks</span>
          </div>
          <div class="sc-bar"><div class="sc-fill" :style="{ width: `${progressPct}%` }"></div></div>
        </div>

        <!-- Part tabs -->
        <div class="part-tabs mono">
          <button class="pt" :class="{ sel: part === 'spec' }" data-testid="part-spec" @click="part = 'spec'">
            spec
          </button>
          <button
            class="pt"
            :class="{ sel: part === 'clarify' }"
            data-testid="part-clarify"
            @click="part = 'clarify'"
          >
            clarify
            <span v-if="detail.clarifications.length > 0" class="pt-badge">{{
              detail.clarifications.length
            }}</span>
          </button>
          <button class="pt" :class="{ sel: part === 'tasks' }" data-testid="part-tasks" @click="part = 'tasks'">
            tasks
            <span v-if="detail.tasksTotal > 0" class="pt-badge dim-badge">{{ detail.tasksTotal }}</span>
          </button>
        </div>

        <!-- spec sections -->
        <div v-if="part === 'spec'" class="sections" data-testid="spec-sections">
          <div v-if="detail.sections.length === 0" class="muted mono">No spec.md content parsed.</div>
          <div v-for="sec in detail.sections" :key="sec.title" class="card section">
            <div class="sec-title mono">## {{ sec.title }}</div>
            <div class="sec-body">{{ sec.body }}</div>
          </div>
        </div>

        <!-- clarifications -->
        <div v-else-if="part === 'clarify'" data-testid="spec-clarify">
          <div v-if="detail.clarifications.length === 0" class="muted mono">
            No open clarifications — the spec has no [NEEDS CLARIFICATION] markers.
          </div>
          <div v-for="(q, i) in detail.clarifications" :key="i" class="card clarify-card">
            <div class="cl-tag mono">NEEDS CLARIFICATION</div>
            <div class="cl-body">{{ q }}</div>
          </div>
        </div>

        <!-- tasks by phase -->
        <div v-else data-testid="spec-tasks">
          <div v-if="detail.phases.length === 0" class="muted mono">
            No tasks.md yet. Run <span class="mono">/tasks</span> to generate the task list.
          </div>
          <div v-for="phase in detail.phases" :key="phase.label" class="phase">
            <div class="phase-label mono">{{ phase.label }}</div>
            <div class="phase-tasks">
              <div
                v-for="task in phase.tasks"
                :key="phase.label + task.id + task.label"
                class="task-row"
                :data-testid="task.done ? 'task-done' : 'task-todo'"
              >
                <span v-if="task.done" class="task-check mono">✓</span>
                <span v-else class="task-box"><span class="box"></span></span>
                <span class="task-id mono">{{ task.id }}</span>
                <span class="task-label" :class="{ done: task.done }">{{ task.label }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.specs {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px;
}

.not-installed {
  max-width: 520px;
  margin: 56px auto 0;
  text-align: center;
}

.ni-icon {
  font-size: 22px;
  color: var(--text-faint);
}

.ni-title {
  font-size: 14px;
  color: var(--text-mid);
  margin-top: 12px;
  font-weight: 600;
}

.ni-sub {
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 8px;
  line-height: 1.6;
}

.ni-btn {
  margin-top: 18px;
}

.ni-error {
  margin-top: 12px;
  font-size: 11px;
  color: var(--red);
  white-space: pre-wrap;
  text-align: left;
}

.has-specs {
  max-width: 840px;
}

.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-meta);
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--border-strong);
  color: var(--text-body);
}

.chip.sel {
  color: var(--text-bright);
  background: var(--bg-active);
  border-color: var(--border-strong);
}

.chip .dot {
  width: 8px;
  height: 8px;
  border-radius: 99px;
}

.spec-card {
  border-radius: 12px;
}

.sc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sc-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.sc-status {
  font-size: 10px;
  padding: 2px 9px;
  border-radius: 99px;
  border: 1px solid var(--border-strong);
  color: var(--text-meta);
}

.sc-status.in_progress {
  color: var(--blue);
  border-color: rgba(110, 168, 232, 0.35);
  background: rgba(110, 168, 232, 0.08);
}

.sc-status.complete {
  color: var(--green);
  border-color: rgba(62, 207, 154, 0.35);
  background: rgba(62, 207, 154, 0.08);
}

.sc-path {
  font-size: 10.5px;
  color: var(--text-faint);
}

.sc-desc {
  font-size: 12.8px;
  line-height: 1.6;
  color: var(--text-mid);
  margin-top: 8px;
  text-wrap: pretty;
}

.sc-progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  font-size: 11px;
  color: var(--text-faint);
}

.sc-bar {
  height: 4px;
  border-radius: 99px;
  background: var(--bg-code);
  margin-top: 10px;
  overflow: hidden;
}

.sc-fill {
  height: 100%;
  border-radius: 99px;
  background: var(--green);
  transition: width 0.3s ease;
}

.part-tabs {
  display: flex;
  gap: 2px;
  margin: 18px 0 10px;
  border-bottom: 1px solid var(--border);
}

.pt {
  padding: 8px 13px;
  font-size: 11.5px;
  color: var(--text-tab);
  cursor: pointer;
  display: flex;
  gap: 6px;
  align-items: center;
  background: transparent;
}

.pt:hover {
  color: var(--text-body);
}

.pt.sel {
  color: var(--text-strong);
  box-shadow: inset 0 -2px 0 var(--green);
}

.pt-badge {
  font-size: 10px;
  color: var(--amber);
  background: rgba(232, 180, 90, 0.13);
  border: 1px solid rgba(232, 180, 90, 0.35);
  border-radius: 99px;
  padding: 0 6px;
  line-height: 15px;
}

.pt-badge.dim-badge {
  color: var(--text-meta);
  background: var(--bg-chip);
  border-color: var(--border-strong);
}

.sections {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section {
  border-radius: 12px;
  padding: 12px 14px;
}

.sec-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-body);
}

.sec-body {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-mid);
  margin-top: 6px;
  white-space: pre-wrap;
  text-wrap: pretty;
}

.clarify-card {
  border-radius: 12px;
  margin-bottom: 8px;
  border-color: rgba(232, 180, 90, 0.35);
}

.cl-tag {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--amber);
}

.cl-body {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-body);
  margin-top: 6px;
}

.phase {
  margin-bottom: 12px;
}

.phase-label {
  font-size: 11px;
  color: var(--text-meta);
  margin: 0 2px 6px;
}

.phase-tasks {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-card-alt);
  border-radius: 8px;
}

.task-check {
  font-size: 12px;
  color: var(--green);
  width: 14px;
}

.task-box {
  width: 14px;
  min-width: 14px;
}

.task-box .box {
  display: block;
  width: 11px;
  height: 11px;
  border-radius: 4px;
  border: 1.5px solid var(--border-strong);
}

.task-id {
  font-size: 10.5px;
  color: var(--text-faint);
}

.task-label {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-body);
}

.task-label.done {
  color: var(--text-tab);
  text-decoration: line-through;
}

.muted {
  font-size: 12.5px;
  color: var(--text-faint);
  padding: 14px 2px;
  line-height: 1.6;
}
</style>
