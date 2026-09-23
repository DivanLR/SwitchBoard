<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { FLOW_STACK_LABELS, type FlowFeature } from '@shared/domain'
import type { FlowStartSource } from '@shared/ipc-types'
import { useFlowStore } from '@renderer/stores/flow'
import Icon from '@renderer/components/Icon.vue'

type Source = 'text' | 'ado' | 'spec'

const SOURCES: readonly { id: Source; label: string }[] = [
  { id: 'text', label: 'Describe it' },
  { id: 'ado', label: 'Azure DevOps' },
  { id: 'spec', label: 'Existing spec' },
]

const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ (e: 'started', runId: string): void }>()
const flow = useFlowStore()

const source = ref<Source>('text')
const title = ref('')
const description = ref('')
const query = ref('')
const feature = ref<FlowFeature | null>(null)
const specId = ref('')
const baseBranch = ref('')
const autopilot = ref(false)
const autoShip = ref(false)
const searched = ref(false)

onMounted(() => {
  void flow.loadExistingSpecs(props.projectId)
  void flow.detectStacks(props.projectId)
})

const chosen = computed<FlowStartSource | null>(() => {
  if (source.value === 'text') {
    const named = title.value.trim()
    return named ? { kind: 'text', title: named, description: description.value.trim() } : null
  }
  if (source.value === 'ado') {
    const picked = feature.value
    return picked ? { kind: 'ado', featureId: picked.id, featureTitle: picked.title, url: picked.url } : null
  }
  return specId.value ? { kind: 'spec', specId: specId.value } : null
})

const missing = computed(() => {
  if (chosen.value) return null
  if (source.value === 'text') return 'Give the feature a title to start.'
  if (source.value === 'ado') return 'Pick a Feature from Azure DevOps to start.'
  return 'Pick an existing spec to start.'
})

function pickSource(next: Source): void {
  source.value = next
  if (next === 'ado' && !searched.value) void search()
}

async function search(): Promise<void> {
  searched.value = true
  feature.value = null
  await flow.searchFeatures(props.projectId, query.value)
}

async function start(): Promise<void> {
  const picked = chosen.value
  if (!picked) return
  const runId = await flow.start(
    props.projectId,
    picked,
    autopilot.value,
    autopilot.value && autoShip.value,
    baseBranch.value.trim() || undefined,
  )
  if (runId) emit('started', runId)
}
</script>

<template>
  <div class="flow-intake" data-testid="flow-create">
    <div class="fin-field">
      <span id="flow-source-label" class="fin-label">Start from</span>
      <div class="ui-segments" role="radiogroup" aria-labelledby="flow-source-label">
        <button
          v-for="item in SOURCES"
          :key="item.id"
          type="button"
          role="radio"
          class="ui-seg"
          :class="{ 'is-on': source === item.id }"
          :aria-checked="source === item.id"
          :data-testid="`flow-source-${item.id}`"
          @click="pickSource(item.id)"
        >
          <Icon v-if="source === item.id" name="check" :size="11" />
          {{ item.label }}
        </button>
      </div>
    </div>

    <template v-if="source === 'text'">
      <label class="fin-field">
        <span class="fin-label">Title</span>
        <input v-model="title" data-testid="flow-text-title" placeholder="Name the feature in a few words" />
      </label>
      <label class="fin-field">
        <span class="fin-label">What should it do?</span>
        <textarea
          v-model="description"
          data-testid="flow-text-description"
          rows="4"
          placeholder="Optional. The behaviour you want, and anything the spec must cover."
        ></textarea>
      </label>
    </template>

    <div v-else-if="source === 'ado'" class="fin-field">
      <span class="fin-label">Feature</span>
      <div class="fin-search">
        <input
          v-model="query"
          data-testid="flow-feature-search"
          placeholder="Search Features, or leave blank for the most recent"
          @keydown.enter="search()"
        />
        <button
          type="button"
          class="btn-quiet"
          data-testid="flow-feature-refresh"
          :disabled="flow.searching"
          @click="search()"
        >
          {{ flow.searching ? 'Asking DevOps…' : 'Find features' }}
        </button>
      </div>
      <div class="fin-list" role="radiogroup" aria-label="Feature">
        <button
          v-for="item in flow.features"
          :key="item.id"
          type="button"
          role="radio"
          class="ui-row"
          :class="{ 'is-selected': feature?.id === item.id }"
          :aria-checked="feature?.id === item.id"
          :data-testid="`flow-feature-${item.id}`"
          @click="feature = item"
        >
          <Icon :name="feature?.id === item.id ? 'check' : 'circle'" :size="11" class="fin-mark" />
          <span class="ui-desc fin-name">{{ item.title }}</span>
          <span class="ui-meta">{{ item.id }}</span>
          <span v-if="item.state" class="ui-chip">{{ item.state }}</span>
        </button>
        <div v-if="flow.features.length === 0" class="ui-empty-line" data-testid="flow-features-empty">
          {{ flow.searching ? 'Asking Azure DevOps for Features…' : (flow.featuresNote ?? 'No Features loaded yet.') }}
        </div>
      </div>
    </div>

    <div v-else class="fin-field">
      <span class="fin-label">Spec</span>
      <div class="fin-list" role="radiogroup" aria-label="Spec">
        <button
          v-for="spec in flow.existingSpecs"
          :key="spec.id"
          type="button"
          role="radio"
          class="ui-row"
          :class="{ 'is-selected': specId === spec.id }"
          :aria-checked="specId === spec.id"
          :data-testid="`flow-existing-spec-${spec.id}`"
          @click="specId = spec.id"
        >
          <Icon :name="specId === spec.id ? 'check' : 'circle'" :size="11" class="fin-mark" />
          <span class="ui-desc fin-name">{{ spec.title }}</span>
          <span class="ui-meta">{{ spec.id }}</span>
        </button>
        <div v-if="flow.existingSpecs.length === 0" class="ui-empty-line" data-testid="flow-specs-empty">
          No spec folders found under specs/ in this project.
        </div>
      </div>
    </div>

    <div class="fin-options">
      <div class="fin-field">
        <span class="fin-label">Stacks</span>
        <div class="fin-stacks" data-testid="flow-stack-chips">
          <span v-for="stackId in flow.detectedStacks" :key="stackId" class="ui-chip" :data-testid="`flow-stack-${stackId}`">
            {{ FLOW_STACK_LABELS[stackId] }}
          </span>
          <span v-if="flow.detectedStacks.length === 0" class="fin-hint" data-testid="flow-stack-none">
            No .NET or Angular project detected here.
          </span>
        </div>
      </div>
      <label class="fin-field">
        <span class="fin-label">Base branch</span>
        <input v-model="baseBranch" class="fin-branch" data-testid="flow-base-branch" placeholder="Leave blank for the current branch" />
      </label>
      <label class="fin-switch">
        <span class="fin-switch-text">
          <span class="fin-switch-name">Autopilot</span>
          <span class="fin-hint">Run every stage without stopping for approval.</span>
        </span>
        <button
          type="button"
          role="switch"
          class="switch"
          :class="{ on: autopilot }"
          :aria-checked="autopilot"
          data-testid="flow-autopilot-new"
          @click="autopilot = !autopilot"
        >
          <span class="knob"></span>
        </button>
      </label>
      <label v-if="autopilot" class="fin-switch">
        <span class="fin-switch-text">
          <span class="fin-switch-name">Raise the pull request at the end</span>
          <span class="fin-hint">Without this, autopilot stops before the pull request.</span>
        </span>
        <button
          type="button"
          role="switch"
          class="switch"
          :class="{ on: autoShip }"
          :aria-checked="autoShip"
          data-testid="flow-autoship-new"
          @click="autoShip = !autoShip"
        >
          <span class="knob"></span>
        </button>
      </label>
    </div>

    <div class="fin-start">
      <button
        type="button"
        class="btn-solid"
        data-testid="flow-start"
        :disabled="!chosen || flow.busy === 'start'"
        :aria-describedby="missing ? 'flow-start-reason' : undefined"
        @click="start()"
      >
        {{ flow.busy === 'start' ? 'Starting…' : 'Start' }}
      </button>
      <span v-if="missing" id="flow-start-reason" class="fin-hint" data-testid="flow-start-reason">{{ missing }}</span>
    </div>
  </div>
</template>

<style scoped>
.flow-intake {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  max-width: 720px;
}

.fin-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.fin-label {
  font: var(--w-em) var(--fs-meta) / 1.2 var(--sans);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-meta);
}

.fin-field input,
.fin-field textarea {
  width: 100%;
  font-size: var(--fs-ui);
}

.fin-field textarea {
  resize: vertical;
  line-height: 1.5;
}

.fin-field .ui-segments {
  align-self: flex-start;
}

.fin-search {
  display: flex;
  gap: var(--sp-3);
}

.fin-search input {
  flex: 1;
}

.fin-search .btn-quiet {
  flex-shrink: 0;
}

.fin-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 280px;
  overflow-y: auto;
}

.fin-mark {
  flex-shrink: 0;
  color: var(--text-faint);
}

.ui-row.is-selected .fin-mark {
  color: var(--green);
}

.fin-name {
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.fin-options {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--border);
}

.fin-stacks {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  min-height: 20px;
}

.fin-branch {
  max-width: 320px;
}

.fin-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-5);
  cursor: pointer;
}

.fin-switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fin-switch-name {
  font-size: var(--fs-ui);
  line-height: 1.4;
  color: var(--text-body);
}

.fin-hint {
  font-size: var(--fs-meta);
  line-height: 1.4;
  color: var(--text-meta);
}

.fin-start {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--border);
}
</style>
