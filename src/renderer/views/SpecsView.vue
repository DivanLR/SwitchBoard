<script setup lang="ts">
// Per-project specs view backed by GitHub Spec Kit — 1:1 with the design
// (Switchboard.dc.html): spec chips, a spec card with status + progress, part
// tabs (spec.md / plan.md / tasks.md / Clarify / Commands), the Commands tab
// with SUGGESTED NEXT + ALL COMMANDS, and the SUGGEST AN EDIT bar. When Spec
// Kit is not installed, an install button scaffolds it per-project.
import { computed, ref, watch } from 'vue'
import type { SpecPhase, SpecStatus } from '@shared/domain'
import { SPEC_KIT_COMMANDS } from '@shared/domain'
import { useSpecsStore } from '@renderer/stores/specs'

const props = defineProps<{ projectId: string }>()
const specs = useSpecsStore()

type Part = 'spec' | 'plan' | 'tasks' | 'clarify' | 'cmds'
const part = ref<Part>('tasks')

/** Send a stage command scoped to the selected spec (design: cmd + spec id). */
function runCommand(command: string): void {
  const suffix = detail.value ? ` ${detail.value.id}` : ''
  void specs.runInSession(props.projectId, `/${command}${suffix}`)
}

// The phase whose "Start phase" launched the current run (design: ● Running…).
const runningPhase = ref<string | null>(null)

/**
 * Start implementing a whole spec with live updates. Uses the
 * scaffold-and-implement flow: every task lands as a complete, verified slice.
 */
function startImplementation(): void {
  if (!detail.value) return
  runningPhase.value = null
  void specs.startPhase(
    props.projectId,
    detail.value.id,
    `/speckit-implement-scaffold Work through the remaining tasks in ${detail.value.path}/tasks.md, marking each [X] as it completes.`,
  )
}

/** Start implementing one phase, scoped by its label. */
function startPhase(phase: SpecPhase): void {
  if (!detail.value) return
  runningPhase.value = phase.label
  const ids = phase.tasks
    .filter((t) => !t.done)
    .map((t) => t.id)
    .filter(Boolean)
    .join(', ')
  void specs.startPhase(
    props.projectId,
    detail.value.id,
    `/speckit-implement-scaffold Implement "${phase.label}" in ${detail.value.path}` +
      (ids ? ` (tasks ${ids})` : '') +
      `. Complete only that phase's tasks and mark each [X] in tasks.md as you finish.`,
  )
}

function phaseDone(phase: SpecPhase): boolean {
  return phase.tasks.length > 0 && phase.tasks.every((t) => t.done)
}

function phaseCount(phase: SpecPhase): string {
  return `${phase.tasks.filter((t) => t.done).length}/${phase.tasks.length}`
}

function phaseRunning(phase: SpecPhase): boolean {
  if (!running.value) return false
  if (runningPhase.value) return runningPhase.value === phase.label
  // Whole-spec run: the first phase that still has open tasks is the live one.
  const current = detail.value?.phases.find((p) => p.tasks.some((t) => !t.done))
  return current?.label === phase.label
}

watch(
  () => props.projectId,
  (projectId) => {
    void specs.loadState(projectId)
  },
  { immediate: true },
)

const state = computed(() => specs.stateFor(props.projectId))
const detail = computed(() => specs.detail)
const running = computed(() => specs.isRunning(props.projectId))
watch(running, (r) => {
  if (!r) runningPhase.value = null
})

const statusLabel: Record<SpecStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  in_progress: 'Implementing',
  complete: 'Done',
}

const progressPct = computed(() => {
  const d = detail.value
  if (!d || d.tasksTotal === 0) return 0
  return Math.round((d.tasksDone / d.tasksTotal) * 100)
})

const STATUS_DOT: Record<SpecStatus, string> = {
  draft: 'var(--text-meta)',
  ready: 'var(--amber)',
  in_progress: 'var(--blue)',
  complete: 'var(--green)',
}

function statusDot(status: SpecStatus): string {
  return STATUS_DOT[status]
}

// Sections for the docs parts: spec.md or plan.md (design: partDocs).
const docSections = computed(() => {
  const d = detail.value
  if (!d) return []
  return part.value === 'plan' ? (d.plan ?? []) : d.sections
})

const openQs = computed(() =>
  (detail.value?.clarifications ?? []).map((q, i) => ({ id: `Q${i + 1}`, q })),
)
const closedQs = computed(() => detail.value?.resolvedClarifications ?? [])

// SUGGESTED NEXT (design logic): open clarifications → clarify; implementing →
// analyze; done → checklist; otherwise implement.
const suggested = computed(() => {
  const d = detail.value
  if (!d) return null
  const open = openQs.value.length
  if (open > 0)
    return {
      command: 'speckit-clarify',
      label: '/speckit.clarify',
      why: `${open} open clarification${open > 1 ? 's' : ''} on this spec — resolve the ambiguity before more code gets written`,
    }
  if (running.value || d.status === 'in_progress')
    return {
      command: 'speckit-analyze',
      label: '/speckit.analyze',
      why: 'Implementation is running — cross-check spec, plan, and tasks for drift',
    }
  if (d.status === 'complete')
    return {
      command: 'speckit-checklist',
      label: '/speckit.checklist',
      why: 'Every task is checked off — generate a review checklist for the finished work',
    }
  return {
    command: 'speckit-implement-scaffold',
    label: '/speckit.implement-scaffold',
    why: 'Spec and plan are settled — execute the remaining tasks as scaffolded, verified slices',
  }
})

// ✎ Refine on a section/task/question sets a spec-edit target on the shared
// composer (which stays visible under this view) — the reply lands in the chat.
const emit = defineEmits<{ (e: 'set-target', label: string): void }>()

function setTarget(label: string): void {
  emit('set-target', label)
}

const partTabs: { id: Part; label: string }[] = [
  { id: 'spec', label: 'spec.md' },
  { id: 'plan', label: 'plan.md' },
  { id: 'tasks', label: 'tasks.md' },
  { id: 'clarify', label: 'Clarify' },
  { id: 'cmds', label: 'Commands' },
]
</script>

<template>
  <div class="specs" data-testid="specs-view">
    <!-- Not installed: offer per-project install -->
    <div v-if="!state.installed" class="not-installed" data-testid="specs-not-installed">
      <div class="ni-icon mono">◇</div>
      <div class="ni-title">Spec Kit is not set up in this project</div>
      <div class="ni-sub">
        GitHub Spec Kit adds a spec-driven workflow (<span class="mono">/speckit.specify</span>,
        <span class="mono">/speckit.plan</span>, <span class="mono">/speckit.tasks</span>,
        <span class="mono">/speckit.implement</span>). It installs into this project only — nothing
        global.
      </div>
      <button
        class="btn-solid ni-btn"
        data-testid="specs-install"
        :disabled="specs.installing"
        @click="specs.install(props.projectId)"
      >
        {{ specs.installing ? 'Installing…' : 'Install Spec Kit in this project' }}
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
        Run <span class="mono">/speckit.specify</span> in the session to scaffold one with
        spec-kit.
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
          <span class="chip-dot" :style="{ color: statusDot(s.status) }">●</span>{{ s.id }}
        </button>
      </div>

      <template v-if="detail">
        <!-- Spec card -->
        <div class="spec-card">
          <div class="sc-head">
            <span class="sc-title mono">{{ detail.title }}</span>
            <span class="sc-status mono" :class="detail.status">{{
              statusLabel[detail.status]
            }}</span>
            <span style="flex: 1"></span>
            <span class="sc-path mono">{{ detail.path }}/</span>
          </div>
          <div v-if="detail.description" class="sc-desc">{{ detail.description }}</div>
          <div class="sc-progress-row">
            <button
              v-if="detail.status !== 'complete' && !running && detail.tasksTotal > 0"
              class="impl-btn mono"
              data-testid="start-implementation"
              @click="startImplementation"
            >
              ▶ Start implementation
            </button>
            <span v-if="running" class="impl-running mono" data-testid="implementing">
              ● Implementing…
            </span>
            <span v-if="detail.status === 'complete'" class="mono" style="font-size: 11.5px; color: var(--green)">
              ✓ All tasks complete
            </span>
            <span class="sc-progress-label mono">{{ detail.tasksDone }}/{{ detail.tasksTotal }} tasks</span>
            <span style="flex: 1"></span>
          </div>
          <div class="sc-bar"><div class="sc-fill" :style="{ width: `${progressPct}%` }"></div></div>
        </div>

        <!-- Part tabs: spec.md / plan.md / tasks.md / Clarify / Commands -->
        <div class="part-tabs mono">
          <button
            v-for="t in partTabs"
            :key="t.id"
            class="pt"
            :class="{ sel: part === t.id }"
            :data-testid="`part-${t.id}`"
            @click="part = t.id"
          >
            {{ t.label }}
            <span v-if="t.id === 'clarify' && openQs.length > 0" class="pt-badge">{{
              openQs.length
            }}</span>
          </button>
        </div>

        <!-- spec.md / plan.md sections -->
        <div v-if="part === 'spec' || part === 'plan'" class="sections" data-testid="spec-sections">
          <div v-if="docSections.length === 0" class="muted">
            No {{ part }}.md content parsed.
          </div>
          <div v-for="sec in docSections" :key="sec.title" class="section">
            <div class="sec-head">
              <span class="sec-title mono">## {{ sec.title }}</span>
              <button
                class="sec-refine mono"
                :data-testid="`refine-${sec.title}`"
                @click="setTarget(`${detail.id}/${part}.md · ${sec.title}`)"
              >
                ✎ Refine
              </button>
            </div>
            <div class="sec-body">{{ sec.body }}</div>
          </div>
        </div>

        <!-- Clarify -->
        <div v-else-if="part === 'clarify'" data-testid="spec-clarify">
          <div v-if="openQs.length === 0 && closedQs.length === 0" class="muted">
            No clarifications yet — the spec has no
            <span class="mono" style="color: var(--text-meta)">[NEEDS CLARIFICATION]</span>
            markers.
          </div>

          <div v-if="openQs.length > 0" class="q-label open mono">OPEN · {{ openQs.length }}</div>
          <div class="q-list">
            <div v-for="qq in openQs" :key="qq.id" class="q-card open">
              <div class="q-tags">
                <span class="q-tag mono">[NEEDS CLARIFICATION]</span>
                <span class="q-id mono">{{ qq.id }}</span>
              </div>
              <div class="q-text">{{ qq.q }}</div>
              <div class="q-chips">
                <button
                  class="q-answer mono"
                  :data-testid="`answer-${qq.id}`"
                  @click="setTarget(`${detail.id}/clarify · ${qq.id}`)"
                >
                  ✎ Answer in my own words
                </button>
              </div>
            </div>
          </div>

          <div v-if="closedQs.length > 0" class="q-label resolved mono">
            RESOLVED · {{ closedQs.length }}
          </div>
          <div class="q-list">
            <div
              v-for="(c, i) in closedQs"
              :key="`${c.question}:${c.answer}`"
              class="q-card resolved"
              data-testid="resolved-clarification"
            >
              <div class="q-tags">
                <span class="q-tag resolved mono">RESOLVED</span>
                <span class="q-id mono">Q{{ openQs.length + i + 1 }}</span>
              </div>
              <div class="q-text dim">{{ c.question }}</div>
              <div class="q-answered mono">✓ {{ c.answer }} — written into spec.md</div>
            </div>
          </div>
        </div>

        <!-- Commands -->
        <div v-else-if="part === 'cmds'" data-testid="speckit-commands">
          <template v-if="suggested">
            <div class="cmd-label next mono">SUGGESTED NEXT</div>
            <div class="suggested" data-testid="suggested-next">
              <span class="sug-cmd mono">{{ suggested.label }}</span>
              <span class="sug-why">{{ suggested.why }}</span>
              <button
                class="sug-run mono"
                data-testid="suggested-run"
                @click="runCommand(suggested.command)"
              >
                ▶ Run
              </button>
            </div>
          </template>
          <div class="cmd-label all mono">ALL COMMANDS</div>
          <div class="cmd-hint">Re-run any stage — output streams into the Session tab.</div>
          <div class="cmd-grid">
            <button
              v-for="c in SPEC_KIT_COMMANDS"
              :key="c.command"
              class="cmd-card"
              :data-testid="`speckit-cmd-${c.command}`"
              @click="runCommand(c.command)"
            >
              <div class="cmd-row">
                <span class="cmd-name mono">{{ c.label }}</span>
                <span style="flex: 1"></span>
                <span class="cmd-run mono">▶ Run</span>
              </div>
              <div class="cmd-desc">{{ c.hint }}</div>
            </button>
          </div>
        </div>

        <!-- tasks.md by phase -->
        <div v-else data-testid="spec-tasks">
          <div v-if="detail.phases.length === 0" class="muted">
            No tasks.md yet. Run <span class="mono">/speckit.tasks</span> to generate the task
            list.
          </div>
          <div v-for="phase in detail.phases" :key="phase.label" class="phase">
            <div class="phase-header">
              <span class="phase-label mono">{{ phase.label }}</span>
              <span class="phase-count mono">{{ phaseCount(phase) }}</span>
              <span style="flex: 1"></span>
              <span v-if="phaseRunning(phase)" class="phase-running mono">● Running…</span>
              <span v-else-if="phaseDone(phase)" class="phase-done mono">✓ Done</span>
              <button
                v-else-if="!running"
                class="phase-start mono"
                :data-testid="`start-phase-${phase.label}`"
                title="Implement this phase; tasks tick off as they complete"
                @click="startPhase(phase)"
              >
                ▶ Start phase
              </button>
            </div>
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
                <button
                  class="task-refine mono"
                  title="Target an edit at this task"
                  @click="setTarget(`${detail.id}/tasks.md · ${task.id}`)"
                >
                  ✎
                </button>
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
  font-size: 20px;
  color: var(--text-faint);
}

.ni-title {
  font-size: 13.5px;
  color: var(--text-mid);
  margin-top: 10px;
}

.ni-sub {
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 5px;
  line-height: 1.6;
}

.ni-sub .mono {
  color: var(--text-meta);
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

/* Spec chips */
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
  border: 1px solid var(--surface-line);
  padding: 6px 12px;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--border-strong);
  color: var(--text-body);
}

.chip.sel {
  color: var(--text-bright);
  background: var(--surface-hover);
  border-color: var(--surface-hover-line);
}

/* Spec card */
.spec-card {
  background: var(--bg-card);
  border: 1px solid var(--surface-line);
  padding: 16px 18px;
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
  border: 1px solid var(--border-strong);
  color: var(--text-meta);
}

.sc-status.ready {
  color: var(--amber);
  border-color: rgba(154, 111, 42, 0.4);
  background: rgba(154, 111, 42, 0.07);
}

.sc-status.in_progress {
  color: var(--blue);
  border-color: rgba(58, 98, 145, 0.4);
  background: rgba(58, 98, 145, 0.07);
}

.sc-status.complete {
  color: var(--green);
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.06);
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
}

.impl-btn {
  background: var(--green);
  color: var(--green-ink);
  font-weight: 600;
  font-size: 11.5px;
  padding: 7px 16px;
  cursor: pointer;
  user-select: none;
}

.impl-btn:hover {
  background: var(--green-hover);
}

.impl-running {
  font-size: 11.5px;
  color: var(--blue);
  animation: sbFade 2.2s ease infinite;
}

.sc-progress-label {
  font-size: 11px;
  color: var(--text-faint);
}

.sc-bar {
  height: 4px;
  background: var(--surface-raised);
  margin-top: 10px;
  overflow: hidden;
}

.sc-fill {
  height: 100%;
  background: var(--green);
  transition: width 0.3s ease;
}

/* Part tabs */
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
  background: rgba(154, 111, 42, 0.13);
  border: 1px solid rgba(154, 111, 42, 0.35);
  padding: 0 6px;
  line-height: 15px;
}

/* spec.md / plan.md sections */
.sections {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section {
  padding: 12px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-card-alt);
}

.sec-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sec-title {
  flex: 1;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-body);
}

.sec-refine {
  font-size: 10.5px;
  color: var(--text-faint);
  cursor: pointer;
  border: 1px solid var(--surface-line);
  padding: 2px 8px;
  user-select: none;
  background: transparent;
}

.sec-refine:hover {
  color: var(--green);
  border-color: var(--green);
}

.sec-body {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-mid);
  margin-top: 6px;
  white-space: pre-wrap;
  text-wrap: pretty;
}

/* Clarify */
.q-label {
  font-size: 10px;
  letter-spacing: 0.15em;
  margin: 0 2px 8px;
}

.q-label.open {
  color: var(--amber);
}

.q-label.resolved {
  color: var(--green);
  margin-top: 16px;
}

.q-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.q-card {
  padding: 12px 14px;
}

.q-card.open {
  background: var(--bg-card);
  border: 1px solid rgba(154, 111, 42, 0.3);
}

.q-card.resolved {
  background: var(--surface-sunken);
  border: 1px solid var(--border-card-alt);
}

.q-tags {
  display: flex;
  align-items: center;
  gap: 9px;
}

.q-tag {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--amber);
}

.q-tag.resolved {
  color: var(--green);
}

.q-id {
  font-size: 10.5px;
  color: var(--text-faint);
}

.q-text {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-body);
  margin-top: 6px;
  text-wrap: pretty;
}

.q-text.dim {
  font-size: 12.8px;
  color: var(--text-mid);
}

.q-chips {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.q-answer {
  font-size: 11.5px;
  color: var(--text-faint);
  border: 1px dashed var(--border-strong);
  padding: 5px 12px;
  cursor: pointer;
  user-select: none;
  background: transparent;
}

.q-answer:hover {
  color: var(--text-mid);
}

.q-answered {
  font-size: 11.5px;
  color: var(--green);
  margin-top: 7px;
}

/* Commands */
.cmd-label {
  font-size: 10px;
  letter-spacing: 0.15em;
  margin: 0 2px 8px;
}

.cmd-label.next {
  color: var(--green);
}

.cmd-label.all {
  color: var(--text-faint);
  margin: 20px 2px 4px;
}

.suggested {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 15px;
  background: rgba(52, 211, 153, 0.05);
  border: 1px solid rgba(52, 211, 153, 0.35);
  flex-wrap: wrap;
}

.sug-cmd {
  font-size: 13px;
  font-weight: 700;
  color: var(--green);
  white-space: nowrap;
}

.sug-why {
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-mid);
  text-wrap: pretty;
}

.sug-run {
  flex-shrink: 0;
  background: var(--green);
  color: var(--green-ink);
  font-weight: 600;
  font-size: 11.5px;
  padding: 7px 16px;
  cursor: pointer;
  user-select: none;
}

.sug-run:hover {
  background: var(--green-hover);
}

.cmd-hint {
  font-size: 11.5px;
  color: var(--text-tab);
  margin: 0 2px 10px;
}

.cmd-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.cmd-card {
  padding: 10px 13px;
  background: var(--bg-card);
  border: 1px solid var(--surface-line);
  cursor: pointer;
  user-select: none;
  text-align: left;
}

.cmd-card:hover {
  border-color: var(--green);
}

.cmd-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cmd-name {
  font-size: 12px;
  color: var(--green);
}

.cmd-run {
  font-size: 10px;
  color: var(--text-faint);
}

.cmd-desc {
  font-size: 11.5px;
  color: var(--text-tab);
  margin-top: 4px;
  line-height: 1.5;
  text-wrap: pretty;
}

/* tasks.md */
.phase {
  margin-bottom: 12px;
}

.phase-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 2px 6px;
}

.phase-label {
  font-size: 11px;
  color: var(--text-meta);
}

.phase-count {
  font-size: 10px;
  color: var(--text-faint);
}

.phase-running {
  font-size: 10.5px;
  color: var(--blue);
  animation: sbFade 1.6s ease infinite;
}

.phase-done {
  font-size: 10.5px;
  color: var(--green);
}

.phase-start {
  font-size: 10.5px;
  color: var(--green);
  border: 1px solid rgba(52, 211, 153, 0.35);
  padding: 2px 9px;
  cursor: pointer;
  user-select: none;
  background: transparent;
}

.phase-start:hover {
  background: rgba(52, 211, 153, 0.08);
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

.task-refine {
  font-size: 10.5px;
  color: var(--text-ghost);
  cursor: pointer;
  padding: 0 3px;
  background: transparent;
}

.task-refine:hover {
  color: var(--green);
}

.muted {
  font-size: 12.5px;
  color: var(--text-faint);
  padding: 4px 2px 14px;
  line-height: 1.6;
}
</style>
