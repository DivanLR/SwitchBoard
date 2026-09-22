<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { flowStage, type FlowFeature, type FlowItem, type ScopedItem } from '@shared/domain'
import { useFlowStore } from '@renderer/stores/flow'
import Icon from '@renderer/components/Icon.vue'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'

const props = defineProps<{ projectId: string }>()
const flow = useFlowStore()

const query = ref('')
const confirmingPublish = ref(false)

let stopPush: (() => void) | null = null
onMounted(() => {
  void flow.load(props.projectId)
  void flow.loadLessons(props.projectId)
  stopPush = window.switchboard.on('push.flowChanged', (push) => {
    flow.applyPush(push.projectId, push.runs, push.items)
    // Lessons are their own list, so a run reaching the learning stage has to fetch them.
    if (push.projectId === props.projectId) void flow.loadLessons(push.projectId)
  })
})
onUnmounted(() => stopPush?.())

watch(
  () => props.projectId,
  (id) => {
    confirmingPublish.value = false
    void flow.load(id)
    void flow.loadLessons(id)
  },
)

const run = computed(() => flow.run)
const stage = computed(() => (run.value ? flowStage(run.value.status) : 'pick'))
const items = computed(() => flow.items)

const STAGES: { key: string; label: string }[] = [
  { key: 'pick', label: 'Pick a feature' },
  { key: 'scoping', label: 'Scoping' },
  { key: 'crosscheck', label: 'Second pair of eyes' },
  { key: 'approve', label: 'Approve' },
  { key: 'publishing', label: 'Writing to DevOps' },
  { key: 'ready', label: 'In DevOps' },
  { key: 'learning', label: 'Learning' },
]

const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'blocked', 'pr_interrupted'])

function chipFor(status: string): string {
  if (FAILED_STATUSES.has(status)) return 'high'
  if (status === 'pr_open' || status === 'done') return 'low'
  return 'medium'
}

function scopedFrom(list: readonly FlowItem[]): ScopedItem[] {
  return list.map((item) => ({
    localId: item.localId,
    title: item.title,
    body: item.body,
    acceptance: item.acceptance,
    estimate: item.estimate,
  }))
}

async function search(): Promise<void> {
  await flow.searchFeatures(props.projectId, query.value)
}

async function start(feature: FlowFeature): Promise<void> {
  await flow.start(props.projectId, feature)
}

async function drop(item: FlowItem): Promise<void> {
  if (!run.value) return
  await flow.saveItems(
    props.projectId,
    run.value.id,
    scopedFrom(items.value.filter((other) => other.id !== item.id)),
  )
}

async function publish(): Promise<void> {
  if (!run.value) return
  if (!confirmingPublish.value) {
    confirmingPublish.value = true
    return
  }
  confirmingPublish.value = false
  await flow.publish(props.projectId, run.value.id)
}

async function learn(): Promise<void> {
  if (!run.value) return
  await flow.learn(props.projectId, run.value.id)
}

async function writeSpec(): Promise<void> {
  if (!run.value) return
  await flow.writeSpec(props.projectId, run.value.id)
}

async function startWork(): Promise<void> {
  if (!run.value) return
  await flow.startWork(props.projectId, run.value.id)
}

async function retry(item: FlowItem): Promise<void> {
  await flow.retryItem(props.projectId, item.id)
}

async function cancel(): Promise<void> {
  if (!run.value) return
  confirmingPublish.value = false
  await flow.cancel(props.projectId, run.value.id)
}
</script>

<template>
  <div class="flow-view" data-testid="flow-view">
    <div class="ui-tabs" data-testid="flow-stage-rail">
      <span
        v-for="s in STAGES"
        :key="s.key"
        class="ui-tab"
        :class="{ on: stage === s.key, 'is-selected': stage === s.key }"
        :data-testid="`flow-stage-${s.key}`"
      >
        {{ s.label }}
      </span>
      <span class="fr-spacer"></span>
      <button
        v-if="run && !run.finishedAt"
        type="button"
        class="btn-quiet"
        data-testid="flow-cancel"
        @click="cancel()"
      >
        Stop this flow
      </button>
    </div>

    <div v-if="flow.error" class="ui-err" data-testid="flow-error">{{ flow.error }}</div>

    <div v-if="!run" class="flow-pick" data-testid="flow-pick">
      <div class="ui-toolbar">
        <input
          v-model="query"
          class="fp-input"
          data-testid="flow-feature-search"
          placeholder="Search Azure DevOps Features, or leave blank for the most recent"
          @keydown.enter="search()"
        />
        <button
          type="button"
          class="btn-solid"
          data-testid="flow-feature-refresh"
          :disabled="flow.searching"
          @click="search()"
        >
          {{ flow.searching ? 'Asking DevOps…' : 'Find features' }}
        </button>
      </div>
      <div v-if="flow.searching" class="flow-note faint" data-testid="flow-features-searching">
        A session is reading the board through the DevOps MCP server.
      </div>
      <div
        v-else-if="flow.features.length === 0"
        class="flow-note faint"
        data-testid="flow-features-empty"
      >
        {{ flow.featuresNote ?? 'No features loaded yet.' }}
      </div>
      <div v-else class="fp-list">
        <button
          v-for="feature in flow.features"
          :key="feature.id"
          type="button"
          class="ui-row"
          :data-testid="`flow-feature-${feature.id}`"
          :disabled="flow.busy === 'start'"
          @click="start(feature)"
        >
          <span class="fp-id mono">{{ feature.id }}</span>
          <span class="fp-title">{{ feature.title }}</span>
          <span v-if="feature.state" class="pill">{{ feature.state }}</span>
        </button>
      </div>
    </div>

    <div v-else class="flow-run" data-testid="flow-run">
      <div class="fr-head">
        <span class="frh-id mono">{{ run.featureId }}</span>
        <span class="frh-title">{{ run.featureTitle }}</span>
        <span class="pill" :class="run.status" data-testid="flow-run-status">{{ run.status }}</span>
      </div>
      <div v-if="run.note" class="flow-note" data-testid="flow-run-note">{{ run.note }}</div>

      <div v-if="run.concerns.length > 0" class="flow-concerns" data-testid="flow-concerns">
        <div class="ui-kicker">What the reviewer said</div>
        <ul><li v-for="concern in run.concerns" :key="concern">{{ concern }}</li></ul>
      </div>

      <div v-if="stage === 'scoping' || stage === 'crosscheck'" class="flow-scoping" data-testid="flow-scoping">
        <div class="flow-note faint">
          {{
            stage === 'crosscheck'
              ? 'A second session is reviewing the breakdown. It did not write it, and it can change nothing.'
              : 'Scoping in plan mode. The breakdown appears here when the session hands it back; it changes nothing in Azure DevOps.'
          }}
        </div>
        <MiniTerminal v-if="run.sessionId" :session-id="run.sessionId" data-testid="flow-scoping-session" />
      </div>

      <template v-else-if="items.length > 0">
        <div class="flow-items" data-testid="flow-items">
          <div
            v-for="item in items"
            :key="item.id"
            class="ui-card flow-card"
            :data-testid="`flow-item-${item.localId}`"
          >
            <div class="fi-head">
              <span class="fi-title">{{ item.title }}</span>
              <span
                class="chip-risk"
                :class="chipFor(item.status)"
                :data-testid="`flow-item-${item.localId}-status`"
              >
                {{ item.status }}
              </span>
              <span
                v-if="item.attempts > 1"
                class="ui-chip"
                :data-testid="`flow-item-${item.localId}-attempts`"
                :title="`Restarted ${item.attempts - 1} time(s)`"
              >
                {{ item.attempts - 1 }} restart{{ item.attempts - 1 === 1 ? '' : 's' }}
              </span>
              <a
                v-if="item.prUrl"
                class="ui-chip"
                :href="item.prUrl"
                :data-testid="`flow-item-${item.localId}-pr`"
              >
                PR #<span class="mono">{{ item.prId }}</span>
              </a>
              <span
                v-else-if="item.prId"
                class="ui-chip"
                :data-testid="`flow-item-${item.localId}-pr`"
              >
                PR #<span class="mono">{{ item.prId }}</span>
              </span>
              <span
                v-else-if="item.status === 'pr_open'"
                class="fi-wid-text faint"
                :data-testid="`flow-item-${item.localId}-nopr`"
              >
                no pull request
              </span>
              <button
                v-if="FAILED_STATUSES.has(item.status)"
                type="button"
                class="btn-quiet"
                :data-testid="`flow-item-${item.localId}-retry`"
                @click="retry(item)"
              >
                Retry
              </button>
              <span v-if="item.workItemId" class="ui-chip" :data-testid="`flow-item-${item.localId}-wid`">
                <span class="mono">#{{ item.workItemId }}</span>
              </span>
              <span v-else class="fi-wid-text faint" :data-testid="`flow-item-${item.localId}-nowid`">
                not in DevOps yet
              </span>
              <button
                v-if="stage === 'approve' && item.status === 'proposed'"
                type="button"
                class="btn-quiet"
                :data-testid="`flow-item-${item.localId}-drop`"
                title="Drop this item from the breakdown"
                @click="drop(item)"
              >
                <Icon name="close" :size="11" />
              </button>
            </div>
            <div class="fi-body">{{ item.body }}</div>
            <ul v-if="item.acceptance.length > 0" class="fi-acceptance">
              <li v-for="line in item.acceptance" :key="line">{{ line }}</li>
            </ul>
            <div v-if="item.note" class="fi-note">{{ item.note }}</div>
          </div>
        </div>

        <div v-if="run.risks.length > 0 || run.outOfScope.length > 0" class="flow-asides">
          <div v-if="run.risks.length > 0" data-testid="flow-risks">
            <div class="ui-kicker">Risks</div>
            <ul><li v-for="risk in run.risks" :key="risk">{{ risk }}</li></ul>
          </div>
          <div v-if="run.outOfScope.length > 0" data-testid="flow-out-of-scope">
            <div class="ui-kicker">Left out</div>
            <ul><li v-for="line in run.outOfScope" :key="line">{{ line }}</li></ul>
          </div>
        </div>

        <div class="ui-footer flow-foot" data-testid="flow-spec-foot">
          <span class="flow-foot-note">
            {{
              run.specSessionId
                ? 'The feature spec is being written. It lands in specs/ and shows in the Specs tab.'
                : 'One spec for the whole feature, written from these items by Spec Kit.'
            }}
          </span>
          <button
            type="button"
            class="btn-outline"
            data-testid="flow-spec"
            :disabled="flow.busy === 'spec'"
            @click="writeSpec()"
          >
            {{ flow.busy === 'spec' ? 'Sending…' : run.specSessionId ? 'Write it again' : 'Write the feature spec' }}
          </button>
        </div>
        <MiniTerminal
          v-if="run.specSessionId"
          :session-id="run.specSessionId"
          data-testid="flow-spec-session"
        />

        <div v-if="stage === 'ready' && flow.counts.prOpen > 0" class="ui-footer flow-foot" data-testid="flow-learn-foot">
          <span class="flow-foot-note">
            {{ flow.counts.prOpen }} pull request{{ flow.counts.prOpen === 1 ? '' : 's' }} open. Once
            you have reviewed them, Flow can read your comments and propose standards.
          </span>
          <button
            type="button"
            class="btn-outline"
            data-testid="flow-learn"
            :disabled="flow.busy === 'learn'"
            @click="learn()"
          >
            {{ flow.busy === 'learn' ? 'Reading…' : 'Learn from my review' }}
          </button>
        </div>

        <div v-if="stage === 'ready'" class="ui-footer flow-foot" data-testid="flow-work-foot">
          <span class="flow-foot-note" data-testid="flow-work-counts">
            {{ flow.counts.published }} waiting, {{ flow.counts.working }} running,
            {{ flow.counts.prOpen }} with a PR, {{ flow.counts.blocked + flow.counts.failed }} stuck
          </span>
          <button
            type="button"
            class="btn-solid"
            data-testid="flow-start-work"
            :disabled="flow.busy === 'work' || flow.counts.published === 0"
            @click="startWork()"
          >
            {{ flow.busy === 'work' ? 'Starting…' : `Work these in worktrees` }}
          </button>
        </div>

        <div v-if="stage === 'approve' || stage === 'publishing'" class="ui-footer flow-foot">
          <span class="flow-foot-note">
            {{ flow.counts.proposed }} to create under feature <span class="mono">{{ run.featureId }}</span>,
            {{ flow.counts.published }} already there.
          </span>
          <button
            type="button"
            class="btn-solid"
            data-testid="flow-publish"
            :disabled="flow.busy === 'publish' || flow.counts.proposed === 0 || stage === 'publishing'"
            @click="publish()"
          >
            {{
              stage === 'publishing'
                ? 'Writing…'
                : confirmingPublish
                  ? `Create ${flow.counts.proposed} in DevOps`
                  : 'Write these to DevOps'
            }}
          </button>
        </div>
      </template>

      <div v-else class="flow-note faint" data-testid="flow-no-items">
        This run has no items.
      </div>

      <div v-if="flow.pendingLessons.length > 0" class="flow-lessons" data-testid="flow-lessons">
        <div class="ui-kicker">Proposed standards</div>
        <div class="flow-note faint">
          Each one is written into this project's CLAUDE.md only when you accept it. A rule you
          reject is never proposed again.
        </div>
        <div
          v-for="lesson in flow.pendingLessons"
          :key="lesson.id"
          class="ui-card flow-card"
          :data-testid="`flow-lesson-${lesson.id}`"
        >
          <div class="fl-rule">{{ lesson.rule }}</div>
          <div v-if="lesson.section" class="fl-where mono">under {{ lesson.section }}</div>
          <blockquote v-for="(cited, at) in lesson.evidence" :key="at" class="fl-quote">
            “{{ cited.quote }}”
            <span v-if="cited.author" class="faint"> — {{ cited.author }}</span>
          </blockquote>
          <div class="fl-actions">
            <button
              type="button"
              class="btn-solid"
              :data-testid="`flow-lesson-${lesson.id}-accept`"
              :disabled="flow.busy === 'lesson'"
              @click="flow.decideLesson(projectId, lesson.id, true)"
            >
              Add to CLAUDE.md
            </button>
            <button
              type="button"
              class="btn-quiet"
              :data-testid="`flow-lesson-${lesson.id}-reject`"
              :disabled="flow.busy === 'lesson'"
              @click="flow.decideLesson(projectId, lesson.id, false)"
            >
              Not a rule
            </button>
          </div>
        </div>
        <div v-if="flow.lastWrite" class="flow-note" data-testid="flow-lesson-written">
          {{ flow.lastWrite }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px 24px;
  gap: 14px;
}

.fr-spacer {
  flex: 1;
}

.flow-note {
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.fp-input {
  flex: 1;
  padding: 7px 10px;
  font-size: var(--fs-meta);
  color: var(--text);
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.fp-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
}

.fp-id {
  width: 70px;
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.fp-title {
  flex: 1;
  font-size: var(--fs-meta);
  color: var(--text);
}

.flow-run,
.flow-scoping {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.fr-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.frh-id {
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.frh-title {
  font-size: var(--fs-ui);
  color: var(--text-strong);
}

.flow-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.flow-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fi-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.fi-title {
  flex: 1;
  font-size: var(--fs-meta);
  color: var(--text-strong);
}

.fi-wid-text {
  font-size: var(--fs-micro);
}

.fi-body {
  font-size: var(--fs-meta);
  color: var(--text-mid);
  line-height: 1.5;
}

.fi-acceptance {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.fi-note {
  font-size: var(--fs-micro);
  color: var(--red);
}

.flow-asides {
  display: flex;
  gap: 26px;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.flow-asides ul {
  margin: 4px 0 0;
  padding-left: 18px;
}

.flow-concerns {
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.flow-concerns ul {
  margin: 4px 0 0;
  padding-left: 18px;
}

.flow-lessons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.fl-rule {
  font-size: var(--fs-meta);
  color: var(--text-strong);
}

.fl-where {
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.fl-quote {
  margin: 0;
  padding-left: 10px;
  border-left: 2px solid var(--border-strong);
  font-size: var(--fs-micro);
  color: var(--text-mid);
}

.fl-actions {
  display: flex;
  gap: 8px;
}

.flow-foot {
  justify-content: space-between;
  padding: var(--sp-3) 0;
}

.flow-foot-note {
  font: 400 var(--fs-ui) / 1.5 var(--sans);
  color: var(--text-mid);
}
</style>
