<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { FLOW_KIND_LABELS, FLOW_STACK_LABELS, type FlowFeature, type FlowKind, type FlowStackId } from '@shared/domain'
import type { FlowStartSource } from '@shared/ipc-types'
import { parseAdoFeatureLink } from '@shared/ado-link'
import { sddSlug } from '@shared/sdd'
import { useFlowStore } from '@renderer/stores/flow'
import { useProjectsStore } from '@renderer/stores/projects'
import Icon from '@renderer/components/Icon.vue'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'

type Source = 'text' | 'ado' | 'spec'

const SOURCES: readonly { id: Source; label: string }[] = [
  { id: 'text', label: 'Describe it' },
  { id: 'ado', label: 'Azure DevOps' },
  { id: 'spec', label: 'Existing spec' },
]

const KINDS: readonly FlowKind[] = ['feature', 'bug', 'idea']

const KIND_HINT: Record<FlowKind, string> = {
  feature: 'Spec, plan, build with converge, clean, test, review and a pull request.',
  bug: 'Assess the symptom, fix it, verify the fix, then clean, review and a pull request.',
  idea: 'Intake, research, define, shape and decide. It changes no code.',
}

const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ (e: 'started', runId: string): void }>()
const flow = useFlowStore()
const projects = useProjectsStore()

const kind = ref<FlowKind>('feature')
const source = ref<Source>('text')
const title = ref('')
const description = ref('')
const seededSlug = ref<string | null>(null)
const checklist = ref(false)
const query = ref('')
const link = ref('')
const feature = ref<FlowFeature | null>(null)
const specId = ref('')
const baseBranch = ref('')
const autopilot = ref(false)
const autoShip = ref(false)
const searched = ref(false)
const companions = ref<Record<string, string>>({})

const candidates = computed(() => projects.visibleItems.filter((item) => item.id !== props.projectId))
const stacksOf = (projectId: string): FlowStackId[] => flow.stacksByProject[projectId] ?? []
const unsupported = (projectId: string): boolean => flow.stacksByProject[projectId]?.length === 0
const hostNote = computed(() => {
  const project = projects.items.find((item) => item.id === props.projectId)
  if (project?.defaultSessionMode === 'bypass') {
    return 'Stages run on this machine in accept edits, not bypass: a container mounts only the project folder, not the run’s worktrees.'
  }
  if (project?.useContainers) {
    return 'Stages run on this machine, not in a container: a container mounts only the project folder, not the run’s worktrees.'
  }
  return null
})

onMounted(() => {
  const seed = flow.takeSeed(props.projectId)
  if (seed?.kind === 'spec') {
    source.value = 'spec'
    specId.value = seed.specId
  } else if (seed?.kind === 'text') {
    title.value = seed.title
    description.value = seed.description
  } else if (seed?.kind === 'bug' || seed?.kind === 'idea') {
    kind.value = seed.kind
    title.value = seed.title
    description.value = seed.kind === 'bug' ? seed.symptom : seed.idea
    seededSlug.value = seed.slug ?? null
  }
  void flow.loadExistingSpecs(props.projectId)
  void flow.detectStacks(props.projectId)
  for (const item of candidates.value) void flow.detectStacks(item.id)
})

function toggleCompanion(projectId: string): void {
  const { [projectId]: picked, ...rest } = companions.value
  companions.value = picked === undefined ? { ...companions.value, [projectId]: '' } : rest
}

const linked = computed(() => (link.value.trim() ? parseAdoFeatureLink(link.value) : null))
const listing = computed(() => (flow.searching ? (flow.listingByProject[props.projectId] ?? null) : null))
const emptyLine = computed(() => {
  if (flow.searching === 'reconnect') {
    return 'Reconnecting the Azure DevOps MCP server, then asking it for the Features assigned to you…'
  }
  if (flow.searching) return 'Asking Azure DevOps for the Features assigned to you…'
  const scope = 'This list shows the Features assigned to you that are not closed, removed or done.'
  return flow.featuresNote ? `${flow.featuresNote} ${scope}` : scope
})

const slug = computed(() => seededSlug.value ?? sddSlug(title.value))
const changesCode = computed(() => kind.value !== 'idea')

const chosen = computed<FlowStartSource | null>(() => {
  const named = title.value.trim()
  const text = description.value.trim()
  const pinned = seededSlug.value ?? undefined
  if (kind.value === 'bug') return named ? { kind: 'bug', title: named, symptom: text || named, slug: pinned } : null
  if (kind.value === 'idea') return named ? { kind: 'idea', title: named, idea: text || named, slug: pinned } : null
  if (source.value === 'text') {
    return named ? { kind: 'text', title: named, description: text } : null
  }
  if (source.value === 'ado') {
    const pasted = linked.value
    if (pasted) return { kind: 'ado', featureId: pasted.id, featureTitle: `Feature ${pasted.id}`, url: pasted.url }
    const picked = feature.value
    return picked
      ? { kind: 'ado', featureId: picked.id, featureTitle: picked.title, url: picked.url }
      : null
  }
  return specId.value ? { kind: 'spec', specId: specId.value } : null
})

const missing = computed(() => {
  if (chosen.value) return null
  if (kind.value !== 'feature') return `Give the ${kind.value} a title to start.`
  if (source.value === 'text') return 'Give the feature a title to start.'
  if (source.value === 'ado') return 'Pick a Feature from Azure DevOps to start.'
  return 'Pick an existing spec to start.'
})

function pickKind(next: FlowKind): void {
  kind.value = next
  seededSlug.value = null
}

function pickSource(next: Source): void {
  source.value = next
  if (next === 'ado' && !searched.value) void search()
}

async function search(): Promise<void> {
  searched.value = true
  feature.value = null
  await flow.searchFeatures(props.projectId, query.value)
}

async function reconnect(): Promise<void> {
  feature.value = null
  await flow.searchFeatures(props.projectId, query.value, true)
}

function pickFeature(item: FlowFeature): void {
  feature.value = item
  link.value = ''
}

async function start(): Promise<void> {
  const picked = chosen.value
  if (!picked) return
  if (flow.searching) void flow.cancelFeatures(props.projectId)
  const others = changesCode.value
    ? Object.entries(companions.value).map(([projectId, base]) => ({
        projectId,
        baseBranch: base.trim() || undefined,
      }))
    : []
  const runId = await flow.start(
    props.projectId,
    picked,
    autopilot.value,
    changesCode.value && autopilot.value && autoShip.value,
    changesCode.value ? baseBranch.value.trim() || undefined : undefined,
    others.length > 0 ? others : undefined,
    kind.value === 'feature' && checklist.value,
  )
  if (runId) emit('started', runId)
}
</script>

<template>
  <div class="flow-intake" data-testid="flow-create">
    <div class="fin-field">
      <span id="flow-kind-label" class="fin-label">What is it</span>
      <div class="ui-segments" role="radiogroup" aria-labelledby="flow-kind-label">
        <button
          v-for="item in KINDS"
          :key="item"
          type="button"
          role="radio"
          class="ui-seg"
          :class="{ 'is-on': kind === item }"
          :aria-checked="kind === item"
          :data-testid="`flow-kind-${item}`"
          @click="pickKind(item)"
        >
          <Icon v-if="kind === item" name="check" :size="11" />
          {{ FLOW_KIND_LABELS[item] }}
        </button>
      </div>
      <span class="fin-hint" data-testid="flow-kind-hint">{{ KIND_HINT[kind] }}</span>
    </div>

    <template v-if="kind !== 'feature'">
      <label class="fin-field">
        <span class="fin-label">Title</span>
        <input
          v-model="title"
          :data-testid="`flow-${kind}-title`"
          :placeholder="kind === 'bug' ? 'Name the bug in a few words' : 'Name the idea in a few words'"
        />
      </label>
      <label class="fin-field">
        <span class="fin-label">{{ kind === 'bug' ? 'Symptom' : 'The idea' }}</span>
        <textarea
          v-model="description"
          :data-testid="`flow-${kind}-text`"
          rows="4"
          :placeholder="
            kind === 'bug'
              ? 'What happens, what should happen, a stack trace or an issue link. Blank uses the title.'
              : 'The idea in a sentence or two, or a link to it. Blank uses the title.'
          "
        ></textarea>
      </label>
      <div class="fin-hint" :data-testid="`flow-${kind}-slug`">
        Reports go to <span class="mono">.specify/{{ kind === 'bug' ? 'bugs' : 'assessments' }}/{{ slug }}/</span>.
      </div>
      <div v-if="kind === 'idea'" class="fin-hint" data-testid="flow-idea-note">
        An idea runs in this project’s own checkout, with no worktree and no branch, because it changes no code.
      </div>
    </template>

    <div v-if="kind === 'feature'" class="fin-field">
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

    <template v-if="kind === 'feature' && source === 'text'">
      <label class="fin-field">
        <span class="fin-label">Title</span>
        <input
          v-model="title"
          data-testid="flow-text-title"
          placeholder="Name the feature in a few words"
        />
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

    <template v-else-if="kind === 'feature' && source === 'ado'">
      <label class="fin-field">
        <span class="fin-label">Paste a Feature link or id</span>
        <input
          v-model="link"
          data-testid="flow-feature-link"
          placeholder="https://dev.azure.com/org/project/_workitems/edit/123, or 123"
        />
        <span v-if="linked" class="fin-hint" data-testid="flow-feature-link-recognised">
          Feature <span class="mono">{{ linked.id }}</span>
          <template v-if="linked.project">
            in project <span class="mono">{{ linked.project }}</span>, organisation
            <span class="mono">{{ linked.organisation }}</span>.
          </template>
          <template v-else>, project and organisation from the ado server.</template>
          Start begins the run from it straight away.
        </span>
        <span v-else-if="link.trim()" class="fin-hint fin-bad" data-testid="flow-feature-link-invalid">
          That is not a Feature link or id. Paste a dev.azure.com or visualstudio.com work item link, or its number.
        </span>
      </label>

      <div class="fin-field">
        <span class="fin-label">Or pick one of your Features</span>
        <div class="fin-search">
          <input
            v-model="query"
            data-testid="flow-feature-search"
            placeholder="Filter your Features by title, or leave blank for all of them"
            @keydown.enter="search()"
          />
          <button
            type="button"
            class="btn-quiet"
            data-testid="flow-feature-refresh"
            :disabled="flow.searching !== null"
            @click="search()"
          >
            {{ flow.searching === 'search' ? 'Asking DevOps…' : 'Find features' }}
          </button>
        </div>
        <div v-if="flow.searching" class="fin-progress" data-testid="flow-features-progress">
          <div class="fin-progress-bar">
            <span class="fin-hint">
              Querying every project for the Features assigned to you. One Azure DevOps call can take minutes.
            </span>
            <button
              type="button"
              class="btn-outline"
              data-testid="flow-features-cancel"
              @click="flow.cancelFeatures(projectId)"
            >
              Cancel
            </button>
          </div>
          <MiniTerminal v-if="listing" :session-id="listing" label="ado session" data-testid="flow-features-session" />
        </div>
        <div v-if="flow.adoDown" class="ui-err-banner is-warn fin-ado" role="alert" data-testid="flow-ado-state">
          <span class="fin-ado-text">{{ flow.adoDown }}</span>
          <button
            type="button"
            class="btn-outline"
            data-testid="flow-ado-reconnect"
            :disabled="flow.searching !== null"
            @click="reconnect()"
          >
            {{ flow.searching === 'reconnect' ? 'Reconnecting…' : 'Reconnect' }}
          </button>
        </div>
        <div
          v-if="flow.featuresSkipped && !flow.searching"
          class="ui-err-banner is-warn"
          role="status"
          data-testid="flow-features-skipped"
        >
          Some projects were skipped, so this list may be incomplete: {{ flow.featuresSkipped }}
        </div>
        <div class="fin-list" role="radiogroup" aria-label="Feature">
          <button
            v-for="item in flow.features"
            :key="item.id"
            type="button"
            role="radio"
            class="ui-row"
            :class="{ 'is-selected': !linked && feature?.id === item.id }"
            :aria-checked="!linked && feature?.id === item.id"
            :data-testid="`flow-feature-${item.id}`"
            @click="pickFeature(item)"
          >
            <Icon :name="!linked && feature?.id === item.id ? 'check' : 'circle'" :size="11" class="fin-mark" />
            <span class="ui-desc fin-name">{{ item.title }}</span>
            <span class="ui-meta">{{ item.id }}</span>
            <span v-if="item.project" class="ui-meta" :data-testid="`flow-feature-${item.id}-project`">
              {{ item.project }}
            </span>
            <span v-if="item.state" class="ui-chip">{{ item.state }}</span>
          </button>
          <div
            v-if="flow.features.length === 0"
            class="ui-empty-line"
            data-testid="flow-features-empty"
          >
            {{ emptyLine }}
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="kind === 'feature'" class="fin-field">
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
        <div
          v-if="flow.existingSpecs.length === 0"
          class="ui-empty-line"
          data-testid="flow-specs-empty"
        >
          No spec folders found under specs/ in this project.
        </div>
      </div>
    </div>

    <div class="fin-options">
      <div v-if="changesCode" class="fin-field">
        <span class="fin-label">Stacks</span>
        <div class="fin-stacks" data-testid="flow-stack-chips">
          <span
            v-for="stackId in stacksOf(projectId)"
            :key="stackId"
            class="ui-chip"
            :data-testid="`flow-stack-${stackId}`"
          >
            {{ FLOW_STACK_LABELS[stackId] }}
          </span>
          <span
            v-if="stacksOf(projectId).length === 0"
            class="fin-hint"
            data-testid="flow-stack-none"
          >
            No .NET or Angular project detected here.
          </span>
        </div>
        <div v-if="hostNote" class="fin-hint" data-testid="flow-host-note">{{ hostNote }}</div>
      </div>
      <label v-if="changesCode" class="fin-field">
        <span class="fin-label">Base branch</span>
        <input
          v-model="baseBranch"
          class="fin-branch"
          data-testid="flow-base-branch"
          placeholder="Leave blank for the current branch"
        />
      </label>
      <div v-if="changesCode && candidates.length > 0" class="fin-field">
        <span id="flow-companions-label" class="fin-label">Also change</span>
        <div class="fin-list" role="group" aria-labelledby="flow-companions-label" data-testid="flow-companions">
          <div v-for="item in candidates" :key="item.id" class="fin-companion">
            <button
              type="button"
              role="checkbox"
              class="ui-row"
              :class="{ 'is-selected': item.id in companions }"
              :aria-checked="item.id in companions"
              :disabled="unsupported(item.id) && !(item.id in companions)"
              :data-testid="`flow-companion-${item.id}`"
              @click="toggleCompanion(item.id)"
            >
              <Icon :name="item.id in companions ? 'check' : 'circle'" :size="11" class="fin-mark" />
              <span class="ui-desc fin-name">{{ item.name }}</span>
              <span
                v-for="stackId in stacksOf(item.id)"
                :key="stackId"
                class="ui-chip"
                :data-testid="`flow-companion-${item.id}-stack-${stackId}`"
              >
                {{ FLOW_STACK_LABELS[stackId] }}
              </span>
              <span v-if="unsupported(item.id)" class="ui-meta">No .NET or Angular project</span>
            </button>
            <input
              v-if="item.id in companions"
              v-model="companions[item.id]"
              class="fin-branch"
              :aria-label="`Base branch for ${item.name}`"
              :data-testid="`flow-companion-base-${item.id}`"
              placeholder="Base branch, blank for its current branch"
            />
          </div>
        </div>
      </div>
      <label v-if="kind === 'feature'" class="fin-switch">
        <span class="fin-switch-text">
          <span class="fin-switch-name">Checklist gate</span>
          <span class="fin-hint">
            Run /speckit-checklist after the plan, and hold the plan while checklist items stay open.
          </span>
        </span>
        <button
          type="button"
          role="switch"
          class="switch"
          :class="{ on: checklist }"
          :aria-checked="checklist"
          data-testid="flow-checklist-new"
          @click="checklist = !checklist"
        >
          <span class="knob"></span>
        </button>
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
      <label v-if="autopilot && changesCode" class="fin-switch">
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
      <span
        v-if="missing"
        id="flow-start-reason"
        class="fin-hint"
        data-testid="flow-start-reason"
        >{{ missing }}</span
      >
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

.fin-bad {
  color: var(--red);
}

.fin-progress {
  display: flex;
  flex-direction: column;
}

.fin-progress-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}

.fin-ado {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.fin-ado-text {
  flex: 1;
  min-width: 0;
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

.fin-companion {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.fin-companion .fin-branch {
  margin-left: var(--sp-6);
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
