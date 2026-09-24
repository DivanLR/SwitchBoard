<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { FLOW_KIND_LABELS, FLOW_STACK_LABELS, FLOW_STAGE_LABELS, type FlowStage } from '@shared/domain'
import { flowModeNote } from '@shared/flow-plan'
import { useFlowStore } from '@renderer/stores/flow'
import { useProjectsStore } from '@renderer/stores/projects'
import FlowIntake from '@renderer/components/flow/FlowIntake.vue'
import FlowStageRail from '@renderer/components/flow/FlowStageRail.vue'
import FlowStageDetail from '@renderer/components/flow/FlowStageDetail.vue'

const props = defineProps<{ projectId: string }>()
const flow = useFlowStore()
const projects = useProjectsStore()

const selectedRunId = ref<string | null>(null)
const selectedStage = ref<FlowStage | null>(null)
const creating = ref(false)
const removeConfirm = ref(false)

let stopPush: (() => void) | null = null

function applyFocus(): void {
  const runId = flow.takeFocusedRun(props.projectId)
  if (runId) selectRun(runId)
}

onMounted(() => {
  if (flow.seed?.projectId === props.projectId) creating.value = true
  void flow.load(props.projectId)
  applyFocus()
  stopPush = window.switchboard.on('push.flowChanged', (push) => {
    if (push.projectId === props.projectId) {
      flow.applyPush(push.projectId, push.runs, push.stages, push.live, push.listing, push.signingIn)
    }
  })
})
onUnmounted(() => stopPush?.())

watch(() => flow.focusRunRequest, () => applyFocus())

watch(
  () => props.projectId,
  (id) => {
    selectedRunId.value = null
    creating.value = false
    void flow.load(id)
  },
)

const run = computed(() => flow.runs.find((r) => r.id === selectedRunId.value) ?? null)
const stages = computed(() => (selectedRunId.value ? flow.stagesFor(selectedRunId.value) : []))
const shownStage = computed(
  () => stages.value.find((s) => s.stage === (selectedStage.value ?? run.value?.stage)) ?? null,
)
const finished = computed(() => Boolean(run.value?.finishedAt))
const worktrees = computed(() => Math.max(1, run.value?.repos.filter((repo) => repo.worktreePath).length ?? 0))
const removeLabel = computed(() => {
  const what = worktrees.value > 1 ? `${worktrees.value} worktrees` : 'worktree'
  return removeConfirm.value ? `Confirm remove ${what}` : `Remove ${what}`
})
const loaded = computed(() => flow.runsByProject[props.projectId] !== undefined)
const empty = computed(() => loaded.value && flow.runs.length === 0 && !creating.value)
const modeNote = computed(() => {
  const current = run.value
  if (!current) return null
  const project = projects.items.find((p) => p.id === current.projectId)
  return project ? flowModeNote(project.defaultSessionMode, current.autopilot) : null
})

watch([() => run.value?.id, () => run.value?.stage], () => {
  selectedStage.value = run.value?.stage ?? null
})

watch(
  () => run.value?.id,
  () => {
    removeConfirm.value = false
  },
)

function selectRun(id: string): void {
  selectedRunId.value = id
  creating.value = false
}

function openCreate(): void {
  creating.value = true
  selectedRunId.value = null
}

async function startFeature(runId: string): Promise<void> {
  if (await flow.featureFrom(props.projectId, runId)) openCreate()
}

async function removeWorktree(): Promise<void> {
  if (!run.value) return
  if (!removeConfirm.value) {
    removeConfirm.value = true
    return
  }
  removeConfirm.value = false
  await flow.removeWorktree(run.value.id, true)
}
</script>

<template>
  <div class="flow-view" data-testid="flow-view">
    <div v-if="empty" class="ui-empty flow-empty" data-testid="flow-empty">
      <div v-if="flow.error" class="ui-err" role="alert" data-testid="flow-error">{{ flow.error }}</div>
      <p class="ui-empty-sub">
        Flow takes one feature through spec, plan, build, clean, test, review and pull request, each run in its own
        worktree. A bug goes through assess, fix and test first; an idea goes from intake to a decision without
        touching code.
      </p>
      <button type="button" class="btn-solid" data-testid="flow-new" @click="openCreate()">New run</button>
    </div>

    <div v-else-if="loaded || creating" class="flow-cols">
      <nav class="flow-runs" data-testid="flow-run-list" aria-label="Flow runs">
        <div class="ui-toolbar flow-runs-head">
          <span class="ui-kicker">Runs</span>
          <span class="fv-spacer"></span>
          <button type="button" class="btn-solid" data-testid="flow-new" :disabled="creating" @click="openCreate()">
            New run
          </button>
        </div>
        <button
          v-for="item in flow.runs"
          :key="item.id"
          type="button"
          class="ui-row flow-run-row"
          :class="{ 'is-selected': item.id === selectedRunId }"
          :aria-current="item.id === selectedRunId ? 'true' : undefined"
          :data-testid="`flow-run-${item.id}`"
          @click="selectRun(item.id)"
        >
          <span class="frr-title">{{ item.title }}</span>
          <span class="frr-meta">
            <span class="ui-chip" :data-testid="`flow-run-kind-${item.id}`">{{ FLOW_KIND_LABELS[item.kind] }}</span>
            <span class="frr-stage">{{ FLOW_STAGE_LABELS[item.stage] }}</span>
            <span
              v-if="flow.liveFor(item.id)?.waiting"
              class="ui-chip is-warn"
              :data-testid="`flow-run-needs-you-${item.id}`"
            >
              needs you
            </span>
            <span class="fv-spacer"></span>
            <span class="pill" :class="item.status">{{ item.status }}</span>
          </span>
        </button>
      </nav>

      <section class="flow-detail">
        <div v-if="flow.error" class="ui-err-banner flow-error" role="alert" data-testid="flow-error">
          {{ flow.error }}
        </div>

        <FlowIntake v-if="creating" :project-id="projectId" @started="selectRun" />

        <div v-else-if="run" class="flow-run" data-testid="flow-run" :data-run-id="run.id">
          <header class="flow-run-head">
            <div class="frh-main">
              <div class="frh-line">
                <h2 class="ui-title frh-title">{{ run.title }}</h2>
                <span class="pill" :class="run.status" data-testid="flow-run-status">{{ run.status }}</span>
              </div>
              <ul v-if="run.repos.length > 0" class="frh-repos" data-testid="flow-run-repos">
                <li
                  v-for="repo in run.repos"
                  :key="repo.projectId"
                  class="frh-repo"
                  :data-testid="`flow-run-repo-${repo.projectId}`"
                >
                  <div class="frh-chips">
                    <span class="frh-repo-name">{{ repo.name }}</span>
                    <span class="ui-chip mono" title="Branch">{{ repo.branch ?? 'no branch yet' }}</span>
                    <span class="ui-chip mono" title="Base branch">base {{ repo.baseBranch }}</span>
                    <span v-for="stackId in repo.stacks" :key="stackId" class="ui-chip">
                      {{ FLOW_STACK_LABELS[stackId as keyof typeof FLOW_STACK_LABELS] ?? stackId }}
                    </span>
                  </div>
                  <div v-if="repo.worktreePath" class="ui-meta frh-path">{{ repo.worktreePath }}</div>
                </li>
              </ul>
              <div v-else-if="run.kind === 'idea'" class="frh-chips">
                <span class="ui-chip" data-testid="flow-run-primary">Primary checkout, no worktree, no branch</span>
                <span v-if="run.slug" class="ui-chip mono">.specify/assessments/{{ run.slug }}/</span>
              </div>
              <template v-else>
                <div class="frh-chips">
                  <span class="ui-chip mono" title="Branch">{{ run.branch ?? 'no branch yet' }}</span>
                  <span class="ui-chip mono" title="Base branch">base {{ run.baseBranch ?? 'unknown' }}</span>
                  <span v-for="stackId in run.stacks" :key="stackId" class="ui-chip">
                    {{ FLOW_STACK_LABELS[stackId as keyof typeof FLOW_STACK_LABELS] ?? stackId }}
                  </span>
                </div>
                <div v-if="run.worktreePath" class="ui-meta frh-path" data-testid="flow-run-worktree">
                  {{ run.worktreePath }}
                </div>
              </template>
              <div v-if="run.note" class="frh-note" data-testid="flow-run-note">{{ run.note }}</div>
              <div v-if="modeNote" class="frh-note" data-testid="flow-mode-note">{{ modeNote }}</div>
            </div>
            <div class="ui-controls frh-controls">
              <label v-if="!finished" class="frh-switch">
                <span>Autopilot</span>
                <button
                  type="button"
                  role="switch"
                  class="switch"
                  :class="{ on: run.autopilot }"
                  :aria-checked="run.autopilot"
                  data-testid="flow-autopilot-toggle"
                  :disabled="flow.busy === 'autopilot'"
                  @click="flow.setAutopilot(run.id, !run.autopilot)"
                >
                  <span class="knob"></span>
                </button>
              </label>
              <button
                v-if="!finished"
                type="button"
                class="btn-outline"
                data-testid="flow-cancel"
                :disabled="flow.busy === 'cancel'"
                @click="flow.cancel(run.id)"
              >
                Cancel run
              </button>
              <button
                v-if="finished && run.worktreePath"
                type="button"
                class="btn-outline"
                data-testid="flow-remove-worktree"
                :disabled="flow.busy === 'removeWorktree'"
                @click="removeWorktree()"
              >
                {{ removeLabel }}
              </button>
            </div>
          </header>

          <FlowStageRail
            :kind="run.kind"
            :stages="stages"
            :selected="selectedStage ?? run.stage"
            :live="flow.liveFor(run.id)"
            @select="(s) => (selectedStage = s)"
          />

          <FlowStageDetail v-if="shownStage" :run="run" :stage="shownStage" @start-feature="startFeature" />
        </div>

        <div v-else class="ui-empty-line" data-testid="flow-pick">Pick a run on the left, or start a new feature.</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.flow-view {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.flow-empty {
  flex: 1;
  max-width: 760px;
}

.flow-cols {
  display: flex;
  flex: 1;
  min-height: 0;
}

.flow-runs {
  width: 272px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-5) var(--sp-4);
  overflow-y: auto;
  border-right: 1px solid var(--border);
}

.flow-runs-head {
  margin-bottom: var(--sp-3);
}

.fv-spacer {
  flex: 1;
}

.flow-run-row {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-1);
  padding: var(--sp-3);
}

.frr-title {
  font-size: var(--fs-ui);
  line-height: 1.4;
  color: var(--text-body);
}

.frr-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.frr-stage {
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.flow-detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: var(--sp-5) var(--sp-6) var(--sp-7);
}

.flow-error {
  margin-bottom: var(--sp-5);
}

.flow-run {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  max-width: 1120px;
}

.flow-run-head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-5);
}

.frh-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.frh-line {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.frh-title {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.frh-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.frh-path {
  overflow-wrap: anywhere;
}

.frh-repos {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.frh-repo {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.frh-chips .frh-repo-name {
  align-self: center;
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.frh-note {
  font-size: var(--fs-meta);
  color: var(--text-mid);
}

.frh-controls {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--sp-3);
}

.frh-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-ui);
  color: var(--text-mid);
  cursor: pointer;
}
</style>
