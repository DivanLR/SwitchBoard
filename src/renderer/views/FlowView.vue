<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { FLOW_STACK_LABELS, type FlowFeature, type FlowStage } from '@shared/domain'
import type { FlowStartSource } from '@shared/ipc-types'
import { useFlowStore } from '@renderer/stores/flow'
import FlowStageRail from '@renderer/components/flow/FlowStageRail.vue'
import FlowStageDetail from '@renderer/components/flow/FlowStageDetail.vue'

const props = defineProps<{ projectId: string }>()
const flow = useFlowStore()

const selectedRunId = ref<string | null>(null)
const selectedStage = ref<FlowStage | null>(null)
const creating = ref(false)
const source = ref<'ado' | 'text' | 'spec'>('text')
const query = ref('')
const textTitle = ref('')
const textDescription = ref('')
const specId = ref('')
const baseBranch = ref('')
const autopilot = ref(false)
const autoShip = ref(false)
const removeConfirm = ref(false)

let stopPush: (() => void) | null = null
onMounted(() => {
  void flow.load(props.projectId)
  stopPush = window.switchboard.on('push.flowChanged', (push) => {
    if (push.projectId === props.projectId) flow.applyPush(push.projectId, push.runs, push.stages)
  })
})
onUnmounted(() => stopPush?.())

watch(
  () => props.projectId,
  (id) => {
    selectedRunId.value = null
    void flow.load(id)
  },
)

const run = computed(() => flow.runs.find((r) => r.id === selectedRunId.value) ?? null)
const stages = computed(() => (selectedRunId.value ? flow.stagesFor(selectedRunId.value) : []))
const currentStage = computed(
  () => stages.value.find((s) => s.stage === (selectedStage.value ?? run.value?.stage)) ?? null,
)

watch(run, (next) => {
  selectedStage.value = next?.stage ?? null
  removeConfirm.value = false
})

function selectRun(id: string): void {
  selectedRunId.value = id
  creating.value = false
}

async function search(): Promise<void> {
  await flow.searchFeatures(props.projectId, query.value)
}

async function pickAdoFeature(feature: FlowFeature): Promise<void> {
  const id = await flow.start(
    props.projectId,
    { kind: 'ado', featureId: feature.id, featureTitle: feature.title, url: feature.url },
    autopilot.value,
    autoShip.value && autopilot.value,
    baseBranch.value || undefined,
  )
  if (id) selectRun(id)
}

async function startFromText(): Promise<void> {
  const built: FlowStartSource = { kind: 'text', title: textTitle.value.trim(), description: textDescription.value }
  const id = await flow.start(
    props.projectId,
    built,
    autopilot.value,
    autoShip.value && autopilot.value,
    baseBranch.value || undefined,
  )
  if (id) {
    selectRun(id)
    textTitle.value = ''
    textDescription.value = ''
  }
}

async function startFromSpec(): Promise<void> {
  const id = await flow.start(
    props.projectId,
    { kind: 'spec', specId: specId.value },
    autopilot.value,
    autoShip.value && autopilot.value,
    baseBranch.value || undefined,
  )
  if (id) selectRun(id)
}

function openCreate(): void {
  creating.value = true
  selectedRunId.value = null
  query.value = ''
  void flow.searchFeatures(props.projectId, '')
  void flow.loadExistingSpecs(props.projectId)
  void flow.detectStacks(props.projectId)
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
    <div class="flow-cols">
      <div class="flow-runs" data-testid="flow-run-list">
        <div class="ui-toolbar">
          <span class="ui-kicker">Runs</span>
          <span class="fr-spacer"></span>
          <button type="button" class="btn-solid" data-testid="flow-new" @click="openCreate()">
            New feature
          </button>
        </div>
        <div v-if="flow.error" class="ui-err" data-testid="flow-error">{{ flow.error }}</div>
        <button
          v-for="item in flow.runs"
          :key="item.id"
          type="button"
          class="ui-row"
          :class="{ 'is-selected': item.id === selectedRunId }"
          :data-testid="`flow-run-${item.id}`"
          @click="selectRun(item.id)"
        >
          <span class="fr-title">{{ item.title }}</span>
          <span class="ui-chip">{{ item.stage }}</span>
          <span class="pill" :class="item.status">{{ item.status }}</span>
        </button>
        <div v-if="flow.runs.length === 0 && !creating" class="ui-empty-sub" data-testid="flow-no-runs">
          No Flow runs yet for this project.
        </div>
      </div>

      <div class="flow-detail">
        <div v-if="creating" class="flow-create" data-testid="flow-create">
          <div class="ui-tabs">
            <button
              v-for="tab in ['ado', 'text', 'spec'] as const"
              :key="tab"
              type="button"
              class="ui-tab"
              :class="{ on: source === tab }"
              :data-testid="`flow-source-${tab}`"
              @click="source = tab"
            >
              {{ tab === 'ado' ? 'Azure DevOps' : tab === 'text' ? 'Describe it' : 'Existing spec' }}
            </button>
          </div>

          <div v-if="source === 'ado'" class="flow-source-body">
            <div class="ui-toolbar">
              <input
                v-model="query"
                class="fp-input"
                data-testid="flow-feature-search"
                placeholder="Search Azure DevOps Features, or leave blank for the most recent"
                @keydown.enter="search()"
              />
              <button type="button" class="btn-outline" data-testid="flow-feature-refresh" @click="search()">
                {{ flow.searching ? 'Asking DevOps…' : 'Find features' }}
              </button>
            </div>
            <div v-if="flow.features.length === 0" class="ui-empty-sub" data-testid="flow-features-empty">
              {{ flow.featuresNote ?? 'No features loaded yet.' }}
            </div>
            <button
              v-for="feature in flow.features"
              :key="feature.id"
              type="button"
              class="ui-row"
              :data-testid="`flow-feature-${feature.id}`"
              @click="pickAdoFeature(feature)"
            >
              <span class="mono">{{ feature.id }}</span>
              <span class="fr-title">{{ feature.title }}</span>
            </button>
          </div>

          <div v-else-if="source === 'text'" class="flow-source-body">
            <input
              v-model="textTitle"
              class="fp-input"
              data-testid="flow-text-title"
              placeholder="Feature title"
            />
            <textarea
              v-model="textDescription"
              class="fp-textarea"
              data-testid="flow-text-description"
              rows="4"
              placeholder="What should it do?"
            ></textarea>
            <button
              type="button"
              class="btn-solid"
              data-testid="flow-text-start"
              :disabled="!textTitle.trim() || flow.busy === 'start'"
              @click="startFromText()"
            >
              Start
            </button>
          </div>

          <div v-else class="flow-source-body">
            <div v-if="flow.existingSpecs.length === 0" class="ui-empty-sub" data-testid="flow-specs-empty">
              No existing spec folders found.
            </div>
            <button
              v-for="spec in flow.existingSpecs"
              :key="spec.id"
              type="button"
              class="ui-row"
              :class="{ 'is-selected': specId === spec.id }"
              :data-testid="`flow-existing-spec-${spec.id}`"
              @click="specId = spec.id"
            >
              <span class="fr-title">{{ spec.title }}</span>
            </button>
            <button
              type="button"
              class="btn-solid"
              data-testid="flow-spec-start"
              :disabled="!specId || flow.busy === 'start'"
              @click="startFromSpec()"
            >
              Start
            </button>
          </div>

          <div class="flow-create-opts">
            <div class="flow-stacks" data-testid="flow-stack-chips">
              <span
                v-for="stackId in flow.detectedStacks"
                :key="stackId"
                class="ui-chip"
                :data-testid="`flow-stack-${stackId}`"
              >
                {{ FLOW_STACK_LABELS[stackId] }}
              </span>
              <span v-if="flow.detectedStacks.length === 0" class="ui-empty-sub" data-testid="flow-stack-none">
                No .NET or Angular project detected here.
              </span>
            </div>
            <input v-model="baseBranch" class="fp-input" data-testid="flow-base-branch" placeholder="Base branch (optional)" />
            <label class="ui-row flow-switch-row">
              <span>Autopilot — run every stage without stopping for approval</span>
              <span class="switch" :class="{ on: autopilot }" data-testid="flow-autopilot-new" @click="autopilot = !autopilot">
                <span class="knob"></span>
              </span>
            </label>
            <label v-if="autopilot" class="ui-row flow-switch-row">
              <span>Raise the pull request at the end</span>
              <span class="switch" :class="{ on: autoShip }" data-testid="flow-autoship-new" @click="autoShip = !autoShip">
                <span class="knob"></span>
              </span>
            </label>
          </div>
        </div>

        <div v-else-if="run" class="flow-run" data-testid="flow-run" :data-run-id="run.id">
          <div class="fr-head">
            <span class="frh-title">{{ run.title }}</span>
            <span class="ui-chip mono">{{ run.branch ?? '—' }}</span>
            <span class="ui-chip mono">base {{ run.baseBranch ?? '—' }}</span>
            <span v-for="stackId in run.stacks" :key="stackId" class="ui-chip">{{ FLOW_STACK_LABELS[stackId as keyof typeof FLOW_STACK_LABELS] ?? stackId }}</span>
            <span class="pill" :class="run.status" data-testid="flow-run-status">{{ run.status }}</span>
          </div>
          <div v-if="run.worktreePath" class="flow-note mono" data-testid="flow-run-worktree">{{ run.worktreePath }}</div>
          <div v-if="run.note" class="flow-note" data-testid="flow-run-note">{{ run.note }}</div>

          <FlowStageRail :stages="stages" :selected="selectedStage ?? run.stage" @select="(s) => (selectedStage = s)" />

          <FlowStageDetail v-if="currentStage" :run="run" :stage="currentStage" />

          <div class="ui-toolbar flow-foot">
            <label class="ui-row flow-switch-row">
              <span>Autopilot</span>
              <span
                class="switch"
                :class="{ on: run.autopilot }"
                data-testid="flow-autopilot-toggle"
                @click="flow.setAutopilot(run.id, !run.autopilot)"
              >
                <span class="knob"></span>
              </span>
            </label>
            <span class="fr-spacer"></span>
            <button
              v-if="run.worktreePath"
              type="button"
              class="btn-quiet"
              data-testid="flow-remove-worktree"
              @click="removeWorktree()"
            >
              {{ removeConfirm ? 'Confirm remove worktree' : 'Remove worktree' }}
            </button>
          </div>
        </div>

        <div v-else class="ui-empty-sub" data-testid="flow-pick">Pick a run, or start a new feature.</div>
      </div>
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

.flow-cols {
  display: flex;
  flex: 1;
  min-height: 0;
}

.flow-runs {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}

.flow-detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 14px 18px 24px;
}

.fr-spacer {
  flex: 1;
}

.fr-title {
  flex: 1;
  font-size: var(--fs-meta);
  color: var(--text);
  text-align: left;
}

.flow-note {
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.fp-input,
.fp-textarea {
  padding: 7px 10px;
  font-size: var(--fs-meta);
  color: var(--text);
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  width: 100%;
}

.flow-source-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.flow-create-opts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.flow-stacks {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.flow-switch-row {
  justify-content: space-between;
  font-size: var(--fs-meta);
  color: var(--text-mid);
}

.flow-run {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fr-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.frh-title {
  font-size: var(--fs-ui);
  color: var(--text-strong);
}

.flow-foot {
  margin-top: 8px;
}
</style>
