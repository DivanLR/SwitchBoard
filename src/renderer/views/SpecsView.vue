<script setup lang="ts">
import { computed, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import type { SpecPhase, SpecStatus } from '@shared/domain'
import { SPEC_KIT_COMMANDS } from '@shared/command-catalog'
import { errorMessage } from '@renderer/ipc'
import { NEW_SPEC_KEY, useSpecsStore } from '@renderer/stores/specs'
import { useProjectsStore } from '@renderer/stores/projects'
import { useToastsStore } from '@renderer/stores/toasts'
import { useNewSpecDialog } from '@renderer/composables/useNewSpecDialog'
import MarkdownText from '@renderer/components/MarkdownText.vue'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ projectId: string }>()
const specs = useSpecsStore()

const newSpecDialog = useTemplateRef<HTMLElement>('newSpecDialog')
const { showNewSpec, newSpecDesc, newSpec, submitNewSpec, cancelNewSpec } = useNewSpecDialog({
  projectId: () => props.projectId,
  dialog: newSpecDialog,
  onRan: () => emit('ran'), 
})

const speaking = ref(false)

function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '. code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[→⇒]/g, ' to ')
    .replace(/[←⇐]/g, ' from ')
    .replace(/[✦✎⏺⎿■▊●◇✓✗⚖⧉↻▶]/g, ' ') 
    .replace(/[#*_`>|~]/g, ' ') 
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function listen(): void {
  const synth = window.speechSynthesis
  if (speaking.value) {
    synth.cancel()
    speaking.value = false
    return
  }
  const d = detail.value
  if (!d) return
  const text = speakable(
    [d.title, d.description, ...d.sections.map((s) => `${s.title}. ${s.body}`)]
      .filter(Boolean)
      .join('. '),
  )
  const utter = new SpeechSynthesisUtterance(text)
  utter.onend = () => (speaking.value = false)
  utter.onerror = () => (speaking.value = false)
  synth.cancel()
  speaking.value = true
  synth.speak(utter)
}

onUnmounted(() => {
  window.speechSynthesis.cancel()
})

watch([() => props.projectId, () => specs.selectedSpecId], () => {
  window.speechSynthesis.cancel()
  speaking.value = false
})

const IMPLEMENT_KEY = 'implement'
const phaseKey = (label: string): string => `implement:${label}`

type Part = 'spec' | 'plan' | 'tasks' | 'clarify' | 'cmds'
const part = ref<Part>('tasks')

function reportDispatch(p: Promise<unknown>): void {
  void p.catch((e: unknown) => {
    useToastsStore().show('error', 'Could not start that command', errorMessage(e))
  })
}

function controlPhase(key: string): 'starting' | 'running' | null {
  return specs.phaseOf(props.projectId, key)
}

function controlText(key: string, idle: string): string {
  const phase = controlPhase(key)
  return phase === 'starting' ? 'Starting…' : phase === 'running' ? 'Running' : idle
}

function controlIcon(key: string, idle: string): string {
  const phase = controlPhase(key)
  return phase === 'starting' ? 'refresh' : phase === 'running' ? 'dot' : idle
}

function runCommand(command: string): void {
  if (controlPhase(command)) return 
  const suffix = detail.value ? ` ${detail.value.id}` : ''
  reportDispatch(
    specs.runSpecCommand(props.projectId, `/${command}${suffix}`, command, `Running /${command}`),
  )
}



function startImplementation(): void {
  if (!detail.value) return
  emit('ran') 
  reportDispatch(
    specs.startPhase(
      props.projectId,
      detail.value.id,
      `/speckit-implement-scaffold Work through the remaining tasks in ${detail.value.path}/tasks.md, marking each [X] as it completes.`,
      IMPLEMENT_KEY,
    ),
  )
}

function startPhase(phase: SpecPhase): void {
  if (!detail.value) return
  emit('ran') 
  const ids = phase.tasks
    .filter((t) => !t.done)
    .map((t) => t.id)
    .filter(Boolean)
    .join(', ')
  reportDispatch(
    specs.startPhase(
      props.projectId,
      detail.value.id,
      `/speckit-implement-scaffold Implement "${phase.label}" in ${detail.value.path}` +
        (ids ? ` (tasks ${ids})` : '') +
        `. Complete only that phase's tasks and mark each [X] in tasks.md as you finish.`,
      phaseKey(phase.label),
    ),
  )
}

function phaseDone(phase: SpecPhase): boolean {
  return phase.tasks.length > 0 && phase.tasks.every((t) => t.done)
}

type StepState = 'done' | 'active' | 'pending'

function phaseState(phase: SpecPhase): StepState {
  if (phaseDone(phase)) return 'done'
  if (phaseRunning(phase)) return 'active'
  const next = detail.value?.phases.find((p) => p.tasks.some((t) => !t.done))
  return next && next.label === phase.label ? 'active' : 'pending'
}

const specProgress = computed<number>(() => {
  const phases = detail.value?.phases ?? []
  const tasks = phases.flatMap((p) => p.tasks)
  if (tasks.length === 0) return 0
  return Math.round((tasks.filter((t) => t.done).length / tasks.length) * 100)
})

function goToPhase(label: string): void {
  const el = document.querySelector(`[data-phase="${CSS.escape(label)}"]`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function phaseCount(phase: SpecPhase): string {
  return `${phase.tasks.filter((t) => t.done).length}/${phase.tasks.length}`
}

function phaseRunning(phase: SpecPhase): boolean {
  return controlPhase(phaseKey(phase.label)) === 'running' && !phaseDone(phase)
}

async function goToLatestSpec(projectId: string): Promise<void> {
  await specs.loadState(projectId)
  if (projectId !== props.projectId) return 
  const list = specs.stateFor(projectId).specs
  if (list.length === 0) return
  const latest = [...list].sort((a, b) => b.id.localeCompare(a.id))[0]
  if (specs.selectedSpecId !== latest.id) await specs.selectSpec(projectId, latest.id)
}

watch(() => props.projectId, (projectId) => void goToLatestSpec(projectId), { immediate: true })

const state = computed(() => specs.stateFor(props.projectId))
const detail = computed(() => specs.detail)
const running = computed(() => specs.isRunning(props.projectId))
const commandLabel = computed(() => specs.runningLabel(props.projectId))
const runningSessions = computed(() => specs.runningIn(props.projectId))

const projects = useProjectsStore()
const working = computed(
  () =>
    projects.items
      .find((p) => p.id === props.projectId)
      ?.sessions.filter((session) => session.status === 'working').length ?? 0,
)
watch(working, (now, before) => {
  if (before !== undefined && now < before) void specs.reloadSpec(props.projectId)
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

const docSections = computed(() => {
  const d = detail.value
  if (!d) return []
  return part.value === 'plan' ? (d.plan ?? []) : d.sections
})

const openQs = computed(() =>
  (detail.value?.clarifications ?? []).map((q, i) => ({ id: `Q${i + 1}`, q })),
)
const closedQs = computed(() => detail.value?.resolvedClarifications ?? [])

const suggested = computed(() => {
  const d = detail.value
  if (!d) return null
  const open = openQs.value.length
  if (open > 0)
    return {
      command: 'speckit-clarify',
      label: '/speckit.clarify',
      why: `${open} open clarification${open > 1 ? 's' : ''} on this spec — resolve the ambiguity before planning or code`,
    }
  if (!d.plan || d.plan.length === 0)
    return {
      command: 'speckit-plan',
      label: '/speckit.plan',
      why: 'Spec is written but there is no plan.md yet — generate the implementation plan',
    }
  if (d.tasksTotal === 0)
    return {
      command: 'speckit-tasks',
      label: '/speckit.tasks',
      why: 'Plan is in place but tasks.md is empty — break the plan into actionable tasks',
    }
  if (d.tasksDone >= d.tasksTotal)
    return {
      command: 'speckit-checklist',
      label: '/speckit.checklist',
      why: 'Every task is checked off — generate a review checklist for the finished work',
    }
  if (running.value || d.status === 'in_progress')
    return {
      command: 'speckit-analyze',
      label: '/speckit.analyze',
      why: 'Implementation is underway — cross-check spec, plan, and tasks for drift',
    }
  return {
    command: 'speckit-implement-scaffold',
    label: '/speckit.implement-scaffold',
    why: 'Spec, plan, and tasks are settled — execute the remaining tasks as scaffolded, verified slices',
  }
})

const emit = defineEmits<{ (e: 'set-target', label: string): void; (e: 'ran'): void }>()

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
    <div v-if="!state.installed" class="not-installed" data-testid="specs-not-installed">
      <div class="ni-icon"><Icon name="diamond" :size="18" /></div>
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

    <div v-else-if="state.specs.length === 0" class="not-installed" data-testid="specs-empty">
      <div class="ni-icon"><Icon name="diamond" :size="18" /></div>
      <div class="ni-title">No specs in this project</div>
      <template v-if="commandLabel">
        <div class="ni-sub" data-testid="specs-scaffolding">
          {{ commandLabel }}. It appears here when it lands.
        </div>
        <div
          v-for="run in runningSessions"
          :key="run.sessionId"
          class="ni-term"
          :data-testid="`spec-run-${run.key}`"
        >
          <MiniTerminal :session-id="run.sessionId" :label="run.label" />
        </div>
      </template>
      <template v-else>
        <div class="ni-sub">
          Describe a feature and <span class="mono">/speckit.specify</span> scaffolds a spec for it.
        </div>
        <button
          class="btn-solid ni-btn"
          :class="controlPhase(NEW_SPEC_KEY)"
          :disabled="!!controlPhase(NEW_SPEC_KEY)"
          data-testid="specs-new-empty"
          @click="newSpec"
        >
          <Icon :name="controlIcon(NEW_SPEC_KEY, 'plus')" :size="12" />
          {{ controlText(NEW_SPEC_KEY, 'New spec') }}
        </button>
      </template>
    </div>

    <div v-else class="has-specs">
      <div class="chips">
        <button
          v-for="s in state.specs"
          :key="s.id"
          class="chip mono"
          :class="{ sel: s.id === specs.selectedSpecId }"
          :data-testid="`spec-chip-${s.id}`"
          @click="specs.selectSpec(props.projectId, s.id)"
        >
          <span class="chip-dot" :style="{ color: statusDot(s.status) }"><Icon name="dot" :size="8" /></span>{{ s.id }}
        </button>
        <button
          class="chip chip-new mono"
          :class="controlPhase(NEW_SPEC_KEY)"
          :disabled="!!controlPhase(NEW_SPEC_KEY)"
          data-testid="spec-new"
          @click="newSpec"
        >
          <Icon :name="controlIcon(NEW_SPEC_KEY, 'plus')" :size="11" />
          {{ controlText(NEW_SPEC_KEY, 'New spec') }}
        </button>
        <span v-if="commandLabel" class="chip-scaffolding mono" data-testid="specs-scaffolding">
          <Icon name="dot" :size="8" /> {{ commandLabel }}…
        </span>
      </div>

      <div v-for="run in runningSessions" :key="run.sessionId" :data-testid="`spec-run-${run.key}`">
        <MiniTerminal :session-id="run.sessionId" :label="run.label" />
      </div>

      <template v-if="detail">
        <div class="spec-card">
          <div class="sc-head">
            <span class="sc-title mono">{{ detail.title }}</span>
            <span class="sc-status mono" :class="detail.status">{{
              statusLabel[detail.status]
            }}</span>
            <span class="spacer"></span>
            <button
              class="sc-listen mono"
              :class="{ on: speaking }"
              data-testid="spec-listen"
              :title="speaking ? 'Stop reading' : 'Read this spec aloud'"
              @click="listen"
            >
              <Icon :name="speaking ? 'stop' : 'play'" :size="12" /> {{ speaking ? 'Stop' : 'Listen' }}
            </button>
            <span class="sc-path mono">{{ detail.path }}/</span>
          </div>
          <div v-if="detail.description" class="sc-desc">{{ detail.description }}</div>
          <div class="sc-progress-row">
            <button
              v-if="detail.status !== 'complete' && !running && detail.tasksTotal > 0"
              class="impl-btn mono"
              :class="controlPhase(IMPLEMENT_KEY)"
              :disabled="!!controlPhase(IMPLEMENT_KEY)"
              data-testid="start-implementation"
              @click="startImplementation"
            >
              <Icon :name="controlIcon(IMPLEMENT_KEY, 'play')" :size="12" />
              {{ controlText(IMPLEMENT_KEY, 'Start implementation') }}
            </button>
            <span v-if="running" class="impl-running mono" data-testid="implementing">
              <Icon name="dot" :size="8" /> Implementing…
            </span>
            <span v-if="detail.status === 'complete'" class="mono" style="font-size: var(--fs-meta); color: var(--green)">
              <Icon name="check" :size="12" /> All tasks complete
            </span>
            <span class="sc-progress-label mono">{{ detail.tasksDone }}/{{ detail.tasksTotal }} tasks</span>
            <span class="spacer"></span>
          </div>
          <div class="sc-bar"><div class="sc-fill" :style="{ '--fill': progressPct / 100 }"></div></div>
        </div>

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
                <Icon name="pencil" :size="11" /> Refine
              </button>
            </div>
            <MarkdownText class="sec-body" :text="sec.body" />
          </div>
        </div>

        <div v-else-if="part === 'clarify'" data-testid="spec-clarify">
          <div v-if="openQs.length === 0 && closedQs.length === 0" class="muted">
            No clarifications yet — the spec has no
            <span class="mono" style="color: var(--text-meta)">[NEEDS CLARIFICATION]</span>
            markers.
          </div>

          <div v-if="openQs.length > 0" class="q-label open mono">OPEN · {{ openQs.length }}</div>
          <div class="q-list">
            <div v-for="qq in openQs" :key="qq.q" class="q-card open">
              <div class="q-tags">
                <span class="q-tag mono">[NEEDS CLARIFICATION]</span>
                <span class="q-id mono">{{ qq.id }}</span>
              </div>
              <div class="q-text">{{ qq.q }}</div>
              <div class="q-chips">
                <button
                  class="q-answer"
                  :data-testid="`answer-${qq.id}`"
                  @click="setTarget(`${detail.id}/clarify · ${qq.id}`)"
                >
                  <Icon name="pencil" :size="12" /> Answer in my own words
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
              <div class="q-answered"><Icon name="check" :size="12" /> {{ c.answer }} — written into spec.md</div>
            </div>
          </div>
        </div>

        <div v-else-if="part === 'cmds'" data-testid="speckit-commands">
          <template v-if="suggested">
            <div class="cmd-label next mono">SUGGESTED NEXT</div>
            <div class="suggested" data-testid="suggested-next">
              <span class="sug-cmd mono">{{ suggested.label }}</span>
              <span class="sug-why">{{ suggested.why }}</span>
              <button
                class="sug-run mono"
                :class="controlPhase(suggested.command)"
                :disabled="!!controlPhase(suggested.command)"
                data-testid="suggested-run"
                @click="runCommand(suggested.command)"
              >
                <Icon :name="controlIcon(suggested.command, 'play')" :size="12" />
                {{ controlText(suggested.command, 'Run') }}
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
              :class="controlPhase(c.command)"
              :disabled="!!controlPhase(c.command)"
              :data-testid="`speckit-cmd-${c.command}`"
              @click="runCommand(c.command)"
            >
              <div class="cmd-row">
                <span class="cmd-name mono">{{ c.label }}</span>
                <span class="spacer"></span>
                <span class="cmd-run mono">
                  <Icon :name="controlIcon(c.command, 'play')" :size="11" />
                  {{ controlText(c.command, 'Run') }}
                </span>
              </div>
              <div class="cmd-desc">{{ c.hint }}</div>
            </button>
          </div>
        </div>

        <div v-else data-testid="spec-tasks">
          <div v-if="detail.phases.length === 0" class="muted">
            No tasks.md yet. Run <span class="mono">/speckit.tasks</span> to generate the task
            list.
          </div>
          <div v-if="detail.phases.length > 1" class="stepper" data-testid="spec-stepper">
            <div class="step-track" role="progressbar" :aria-valuenow="specProgress" aria-valuemin="0" aria-valuemax="100">
              <span class="step-fill" :style="{ transform: `scaleX(${specProgress / 100})` }"></span>
            </div>
            <ol class="step-list">
              <li
                v-for="(phase, i) in detail.phases"
                :key="phase.label"
                class="step"
                :class="phaseState(phase)"
                :data-testid="`spec-step-${phaseState(phase)}`"
              >
                <button
                  type="button"
                  class="step-btn"
                  :aria-current="phaseState(phase) === 'active' ? 'step' : undefined"
                  :title="`${phase.label} — ${phaseCount(phase)} tasks done`"
                  @click="goToPhase(phase.label)"
                >
                  <span class="step-dot" aria-hidden="true">
                    <Icon v-if="phaseState(phase) === 'done'" name="check" :size="11" />
                    <template v-else>{{ i + 1 }}</template>
                  </span>
                  <span class="step-text">
                    <span class="step-label">{{ phase.label }}</span>
                    <span class="step-count mono">{{ phaseCount(phase) }}</span>
                  </span>
                </button>
              </li>
            </ol>
          </div>

          <div
            v-for="phase in detail.phases"
            :key="phase.label"
            class="phase"
            :data-phase="phase.label"
          >
            <div class="phase-header">
              <span class="phase-label mono">{{ phase.label }}</span>
              <span class="phase-count mono">{{ phaseCount(phase) }}</span>
              <span class="spacer"></span>
              <span v-if="phaseRunning(phase)" class="phase-running mono"><Icon name="dot" :size="8" /> Running…</span>
              <span v-else-if="phaseDone(phase)" class="phase-done mono"><Icon name="check" :size="11" /> Done</span>
              <button
                v-else-if="!running || controlPhase(phaseKey(phase.label))"
                class="phase-start mono"
                :class="controlPhase(phaseKey(phase.label))"
                :disabled="!!controlPhase(phaseKey(phase.label))"
                :data-testid="`start-phase-${phase.label}`"
                title="Implement this phase; tasks tick off as they complete"
                @click="startPhase(phase)"
              >
                <Icon :name="controlIcon(phaseKey(phase.label), 'play')" :size="11" />
                {{ controlText(phaseKey(phase.label), 'Start phase') }}
              </button>
            </div>
            <div class="phase-tasks">
              <div
                v-for="task in phase.tasks"
                :key="phase.label + task.id + task.label"
                class="task-row"
                :data-testid="task.done ? 'task-done' : 'task-todo'"
              >
                <span v-if="task.done" class="task-check mono"><Icon name="check" /></span>
                <span v-else class="task-box"><span class="box"></span></span>
                <span class="task-id mono">{{ task.id }}</span>
                <span class="task-label" :class="{ done: task.done }">{{ task.label }}</span>
                <button
                  class="task-refine mono"
                  :data-testid="`task-refine-${task.id || task.label}`"
                  title="Target an edit at this task"
                  @click="setTarget(`${detail.id}/tasks.md · ${task.id}`)"
                >
                  <Icon name="pencil" :size="11" />
                </button>
              </div>
            </div>
          </div>
        </div>

      </template>
    </div>

    <div
      v-if="showNewSpec"
      class="ns-overlay"
      data-testid="new-spec-popup"
      @click.self="cancelNewSpec"
      @keydown.esc="cancelNewSpec"
    >
      <div
        ref="newSpecDialog"
        class="ns-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-spec-title"
      >
        <div id="new-spec-title" class="ns-title mono">New spec</div>
        <div class="ns-sub">
          Describe the feature in a sentence — <span class="mono">/speckit.specify</span> scaffolds it
          in the background.
        </div>
        <textarea
          v-model="newSpecDesc"
          class="ns-input mono"
          data-testid="new-spec-input"
          rows="3"
          autofocus
          placeholder="e.g. A per-domain container that isolates each client's config, databases, and MCP state…"
          @keydown.enter.exact.prevent="submitNewSpec"
          @keydown.esc="cancelNewSpec"
        ></textarea>
        <div class="ns-actions">
          <button class="btn-quiet" data-testid="new-spec-cancel" @click="cancelNewSpec">Cancel</button>
          <button
            class="btn-solid"
            data-testid="new-spec-submit"
            :disabled="newSpecDesc.trim().length === 0"
            @click="submitNewSpec"
          >
            Create spec
          </button>
        </div>
      </div>
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
  color: var(--text-faint);
}

.ni-title {
  font-size: var(--fs-body);
  color: var(--text-mid);
  margin-top: 10px;
}

.ni-sub {
  font-size: var(--fs-ui);
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
  font-size: var(--fs-meta);
  color: var(--red);
  white-space: pre-wrap;
  text-align: left;
}

.has-specs {
  max-width: none;
}

.sec-body,
.q-text,
.sc-desc {
  max-width: 78ch;
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
  font-size: var(--fs-meta);
  color: var(--text-meta);
  background: var(--bg-card);
  border: 1px solid var(--surface-line);
  border-radius: var(--rp);
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

.chip-new {
  border-style: dashed;
  color: var(--text-faint);
  background: transparent;
}

.chip-new:hover {
  color: var(--green);
  border-color: var(--green);
}

.spec-card {
  background: var(--bg-card);
  border: 1px solid var(--surface-line);
  border-radius: var(--rc);
  padding: 16px 18px;
}

.sc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sc-title {
  font-size: var(--fs-title);
  font-weight: var(--w-em);
  color: var(--text-bright);
}

.sc-status {
  font-size: var(--fs-micro);
  padding: 2px 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--rp);
  color: var(--text-meta);
}

.sc-status.ready {
  color: var(--amber);
  border-color: color-mix(in srgb, var(--amber) 40%, transparent);
  background: color-mix(in srgb, var(--amber) 7%, transparent);
}

.sc-status.in_progress {
  color: var(--blue);
  border-color: color-mix(in srgb, var(--blue) 40%, transparent);
  background: color-mix(in srgb, var(--blue) 7%, transparent);
}

.sc-status.complete {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 35%, transparent);
  background: color-mix(in srgb, var(--green) 6%, transparent);
}

.sc-path {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.sc-listen {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-tab);
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  padding: 3px 10px;
  cursor: pointer;
  background: transparent;
  user-select: none;
}

.sc-listen:hover {
  color: var(--text-body);
  border-color: var(--border-strong);
}

.sc-listen.on {
  color: var(--green);
  border-color: var(--green);
}

.ns-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.ns-box {
  width: min(520px, 90%);
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  padding: 18px 20px;
  box-shadow: var(--elev);
}

.ns-title {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-bright);
}

.ns-sub {
  font-size: var(--fs-ui);
  color: var(--text-faint);
  line-height: 1.55;
  margin-top: 6px;
}

.ns-sub .mono {
  color: var(--text-meta);
}

.ns-input {
  width: 100%;
  margin-top: 12px;
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  color: var(--text-strong);
  font-size: var(--fs-ui);
  line-height: 1.5;
  padding: 8px 10px;
  outline: none;
  resize: vertical;
}

.ns-input:focus {
  border-color: var(--green);
}

.ns-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.sc-desc {
  font-size: var(--fs-ui);
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
  font-weight: var(--w-em);
  font-size: var(--fs-meta);
  padding: 7px 16px;
  cursor: pointer;
  user-select: none;
}

.impl-btn:hover {
  background: var(--green-hover);
}

.impl-running {
  font-size: var(--fs-meta);
  color: var(--blue);
  animation: sbFade 2.2s var(--ease) infinite;
}

.sc-progress-label {
  font-size: var(--fs-meta);
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
  width: 100%;
  background: var(--green);
  transform-origin: left;
  transform: scaleX(var(--fill, 0));
  transition: transform 0.3s var(--ease);
}

.part-tabs {
  display: flex;
  gap: 2px;
  margin: 18px 0 10px;
  border-bottom: 1px solid var(--border);
}

.pt {
  padding: 8px 13px;
  font-size: var(--fs-meta);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
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
  font-size: var(--fs-micro);
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
  border-radius: var(--rp);
  padding: 0 6px;
  line-height: 15px;
}

.sections {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section {
  padding: var(--pad-card);
  background: var(--bg-card);
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rc);
}

.sec-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sec-title {
  flex: 1;
  font-size: var(--fs-meta);
  font-weight: var(--w-em);
  color: var(--text-body);
}

.sec-refine {
  font-size: var(--fs-micro);
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
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-mid);
  margin-top: 6px;
  white-space: pre-wrap;
  text-wrap: pretty;
}

.q-label {
  font-size: var(--fs-micro);
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
  padding: var(--pad-card);
  border-radius: var(--rc);
}

.q-card.open {
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--amber) 30%, transparent);
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
  font-size: var(--fs-micro);
  letter-spacing: 0.1em;
  color: var(--amber);
}

.q-tag.resolved {
  color: var(--green);
}

.q-id {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.q-text {
  font-size: var(--fs-body);
  line-height: 1.55;
  color: var(--text-body);
  margin-top: 6px;
  text-wrap: pretty;
}

.q-text.dim {
  font-size: var(--fs-ui);
  color: var(--text-mid);
}

.q-chips {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.q-answer {
  font-size: var(--fs-meta);
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
  font-size: var(--fs-meta);
  color: var(--green);
  margin-top: 7px;
}

.cmd-label {
  font-size: var(--fs-micro);
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
  background: color-mix(in srgb, var(--green) 5%, transparent);
  border: 1px solid color-mix(in srgb, var(--green) 35%, transparent);
  flex-wrap: wrap;
}

.sug-cmd {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--green);
  white-space: nowrap;
}

.sug-why {
  flex: 1;
  min-width: 200px;
  font-size: var(--fs-ui);
  line-height: 1.5;
  color: var(--text-mid);
  text-wrap: pretty;
}

.sug-run {
  flex-shrink: 0;
  background: var(--green);
  color: var(--green-ink);
  font-weight: var(--w-em);
  font-size: var(--fs-meta);
  padding: 7px 16px;
  cursor: pointer;
  user-select: none;
}

.sug-run:hover {
  background: var(--green-hover);
}

.cmd-hint {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  margin: 0 2px 10px;
}

.cmd-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.cmd-card {
  padding: var(--pad-card);
  background: var(--bg-card);
  border: 1px solid var(--surface-line);
  border-radius: var(--rc);
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
  font-size: var(--fs-ui);
  color: var(--green);
}

.cmd-run {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.cmd-desc {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  margin-top: 4px;
  line-height: 1.5;
  text-wrap: pretty;
}

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
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.phase-count {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.phase-running {
  font-size: var(--fs-micro);
  color: var(--blue);
  animation: sbFade 1.6s var(--ease) infinite;
}

.chip-scaffolding {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-micro);
  color: var(--blue);
  animation: sbFade 1.6s var(--ease) infinite;
}

.phase-done {
  font-size: var(--fs-micro);
  color: var(--green);
}

.phase-start {
  font-size: var(--fs-micro);
  color: var(--green);
  border: 1px solid color-mix(in srgb, var(--green) 35%, transparent);
  padding: 2px 9px;
  cursor: pointer;
  user-select: none;
  background: transparent;
}

.phase-start:hover {
  background: color-mix(in srgb, var(--green) 8%, transparent);
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
  padding: var(--pad-card);
  background: var(--bg-card);
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rc);
}

.task-check {
  font-size: var(--fs-ui);
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
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.task-label {
  flex: 1;
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.task-label.done {
  color: var(--text-tab);
  text-decoration: line-through;
}

.task-refine {
  font-size: var(--fs-micro);
  color: var(--text-ghost);
  cursor: pointer;
  padding: 0 3px;
  background: transparent;
}

.task-refine:hover {
  color: var(--green);
}

.muted {
  font-size: var(--fs-ui);
  color: var(--text-faint);
  padding: 4px 2px 14px;
  line-height: 1.6;
}
.stepper {
  position: relative;
  margin: 0 0 18px;
  padding: 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  box-shadow: var(--elev);
}

.step-track {
  position: absolute;
  top: 23px;
  left: 24px;
  right: 14px;
  height: 2px;
  margin: 0;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
}

.ni-term {
  width: 100%;
  max-width: 640px;
  margin-top: var(--sp-3);
  text-align: left;
}

.starting {
  opacity: 0.65;
  cursor: progress;
}

.running {
  background: var(--green) !important;
  border-color: var(--green) !important;
  color: var(--green-ink) !important;
  cursor: default;
}

.running .cmd-run,
.running .cmd-name,
.running .cmd-desc {
  color: var(--green-ink);
}

.starting :deep(svg) {
  animation: sbSpin 900ms linear infinite;
  transform-origin: center;
}

.running :deep(svg) {
  animation: sbFade 1.6s var(--ease) infinite;
}

@keyframes sbSpin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .starting :deep(svg),
  .running :deep(svg) {
    animation: none;
  }
}

.step-fill {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--green);
  transform-origin: left center;
  transition: transform 300ms var(--ease-overlay);
}

.step-list {
  display: flex;
  flex-wrap: nowrap;
  gap: 10px 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
}

.step-btn {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  padding: 0 12px 0 0;
  background: none;
  border: 0;
  border-radius: var(--rp);
  text-align: left;
  cursor: pointer;
}

.step-btn:hover .step-label {
  color: var(--text-strong);
}

.step-btn:focus-visible {
  outline: 1px solid var(--green);
  outline-offset: 2px;
}

.step-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  border-radius: var(--rp);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  color: var(--text-meta);
}

.step.active .step-dot {
  color: var(--green);
  border-color: var(--green);
}

.step.done .step-dot {
  background: var(--green);
  border-color: var(--green);
  color: var(--green-ink);
}

.step-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.step-label {
  font-size: var(--fs-meta);
  line-height: 1.3;
  color: var(--text-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step.active .step-label {
  color: var(--text-strong);
  font-weight: var(--w-em);
  box-shadow: inset 0 -1px 0 var(--green);
}

.step-count {
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

@media (prefers-reduced-motion: reduce) {
  .step-fill {
    transition: none;
  }
}

</style>
