<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FlowReviewSeverity, FlowRun, FlowStageRecord } from '@shared/domain'
import { useFlowStore } from '@renderer/stores/flow'
import MarkdownText from '@renderer/components/MarkdownText.vue'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ run: FlowRun; stage: FlowStageRecord }>()

const flow = useFlowStore()
const markdown = ref<string | null>(null)
const tasksText = ref<string | null>(null)
const postman = ref<{ path: string | null; content: string } | null | 'missing'>(null)
const showTasks = ref(false)

const TASK_LINE = /^\s*-\s*\[( |x|X)\]\s*(?:T\d+\s*)?(.*)$/

const SEVERITY_CHIP: Record<FlowReviewSeverity, string> = {
  must_fix: 'high',
  should_fix: 'medium',
  nit: 'low',
}
const SEVERITY_LABEL: Record<FlowReviewSeverity, string> = {
  must_fix: 'must fix',
  should_fix: 'should fix',
  nit: 'nit',
}

const taskItems = computed(() => {
  if (!tasksText.value) return []
  return tasksText.value
    .split(/\r?\n/)
    .map((line) => TASK_LINE.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ done: m[1].toLowerCase() === 'x', label: m[2].trim() }))
    .filter((task) => task.label.length > 0)
})

const progress = computed(() => {
  const report = props.stage.report
  if (!report || report.tasksTotal === null || report.tasksTotal === 0) return null
  return { done: report.tasksDone ?? 0, total: report.tasksTotal }
})

function viewKey(): string {
  return `${props.run.id}/${props.stage.stage}`
}

async function loadMarkdown(kind: 'spec' | 'plan'): Promise<void> {
  const key = viewKey()
  const result = await flow.artefact(props.run.id, props.stage.stage, kind)
  if (key === viewKey()) markdown.value = result?.content ?? null
}

async function loadTasks(): Promise<void> {
  const key = viewKey()
  const result = await flow.artefact(props.run.id, props.stage.stage, 'tasks')
  if (key === viewKey()) tasksText.value = result?.content ?? null
}

async function loadPostman(): Promise<void> {
  const key = viewKey()
  const result = await flow.artefact(props.run.id, props.stage.stage, 'postman')
  if (key === viewKey()) postman.value = result ?? 'missing'
}

watch(
  [() => props.run.id, () => props.stage.stage, () => props.stage.status],
  ([runId, stage], previous) => {
    if (!previous || previous[0] !== runId || previous[1] !== stage) {
      showTasks.value = false
      markdown.value = null
      tasksText.value = null
      postman.value = null
    }
    if (stage === 'spec') void loadMarkdown('spec')
    else if (stage === 'plan') void loadMarkdown('plan')
    if (stage === 'build' || (stage === 'plan' && showTasks.value)) void loadTasks()
  },
  { immediate: true },
)

function toggleTasks(): void {
  showTasks.value = !showTasks.value
  if (showTasks.value && tasksText.value === null) void loadTasks()
}
</script>

<template>
  <div class="flow-artefact-view" data-testid="flow-artefact">
    <template v-if="stage.stage === 'spec' || stage.stage === 'plan'">
      <MarkdownText
        v-if="markdown"
        :text="markdown"
        class="flow-doc"
        data-testid="flow-artefact-markdown"
      />
      <div v-else class="ui-empty-line">
        No {{ stage.stage === 'spec' ? 'spec.md' : 'plan.md' }} written yet.
      </div>
      <template v-if="stage.stage === 'plan'">
        <div v-if="progress" class="flow-progress" data-testid="flow-tasks-progress">
          <div class="flow-progress-bar">
            <div
              class="flow-progress-fill"
              :style="{ width: `${(progress.done / progress.total) * 100}%` }"
            ></div>
          </div>
          <span class="ui-chip">{{ progress.done }} / {{ progress.total }} tasks</span>
        </div>
        <button
          type="button"
          class="btn-quiet fa-toggle"
          data-testid="flow-tasks-toggle"
          :aria-expanded="showTasks"
          @click="toggleTasks()"
        >
          <Icon :name="showTasks ? 'minus' : 'plus'" :size="11" />
          {{ showTasks ? 'Hide tasks' : 'View tasks' }}
        </button>
        <ul
          v-if="showTasks && taskItems.length > 0"
          class="flow-tasks"
          data-testid="flow-tasks-checklist"
        >
          <li v-for="(task, at) in taskItems" :key="at" :class="{ done: task.done }">
            <Icon :name="task.done ? 'check' : 'circle'" :size="11" />
            {{ task.label }}
          </li>
        </ul>
      </template>
    </template>

    <template v-else-if="stage.stage === 'build'">
      <div v-if="progress" class="flow-progress" data-testid="flow-tasks-progress">
        <div class="flow-progress-bar">
          <div
            class="flow-progress-fill"
            :style="{ width: `${(progress.done / progress.total) * 100}%` }"
          ></div>
        </div>
        <span class="ui-chip">{{ progress.done }} / {{ progress.total }} tasks</span>
      </div>
      <ul v-if="taskItems.length > 0" class="flow-tasks" data-testid="flow-tasks-checklist">
        <li v-for="(task, at) in taskItems" :key="at" :class="{ done: task.done }">
          <Icon :name="task.done ? 'check' : 'circle'" :size="11" />
          {{ task.label }}
        </li>
      </ul>
      <div v-else class="ui-empty-line">No tasks.md yet.</div>
    </template>

    <template v-else-if="stage.stage === 'test'">
      <div
        v-if="stage.report?.verify?.suites.length"
        class="flow-gates"
        data-testid="flow-test-gates"
      >
        <div v-for="suite in stage.report.verify.suites" :key="suite.id" class="flow-gate-row">
          <span
            class="chip-risk"
            :class="suite.status === 'pass' ? 'low' : suite.status === 'fail' ? 'high' : 'medium'"
          >
            {{ suite.status }}
          </span>
          <span class="fg-label">{{ suite.label }}</span>
          <span class="fg-detail">{{ suite.detail }}</span>
        </div>
      </div>
      <div v-else class="ui-empty-line">No test report yet.</div>
      <button
        type="button"
        class="btn-quiet fa-toggle"
        data-testid="flow-postman-load"
        @click="loadPostman()"
      >
        View Postman collection
      </button>
      <pre
        v-if="postman && postman !== 'missing'"
        class="flow-code"
        data-testid="flow-postman-content"
        >{{ postman.content }}</pre>
      <div
        v-else-if="postman === 'missing'"
        class="ui-empty-sub"
        data-testid="flow-postman-missing"
      >
        No Postman collection for this feature.
      </div>
    </template>

    <template v-else-if="stage.stage === 'review'">
      <template v-if="stage.report">
        <div v-if="stage.report.verdict" class="fa-line">
          <span
            class="ui-chip"
            :class="{ 'is-warn': stage.report.verdict === 'needs_fixes' }"
            data-testid="flow-review-verdict"
          >
            {{ stage.report.verdict === 'needs_fixes' ? 'Needs fixes' : 'Ready' }}
          </span>
        </div>
        <table
          v-if="stage.report.findings?.length"
          class="flow-findings-table"
          data-testid="flow-findings"
        >
          <tbody>
            <tr v-for="(finding, at) in stage.report.findings" :key="at">
              <td>
                <span class="chip-risk" :class="SEVERITY_CHIP[finding.severity]">{{
                  SEVERITY_LABEL[finding.severity]
                }}</span>
              </td>
              <td>{{ finding.what }}</td>
              <td class="mono fg-where">
                {{ finding.file }}{{ finding.line ? `:${finding.line}` : '' }}
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="stage.report.unmet?.length" class="fa-unmet" data-testid="flow-unmet">
          <span class="fa-label">Unmet acceptance criteria</span>
          <ul class="fi-acceptance">
            <li v-for="line in stage.report.unmet" :key="line">{{ line }}</li>
          </ul>
        </div>
        <div
          v-if="!stage.report.findings?.length && !stage.report.unmet?.length"
          class="ui-empty-line"
        >
          No findings, and every acceptance criterion is met.
        </div>
      </template>
      <div v-else class="ui-empty-line">No review yet.</div>
    </template>

    <template v-else-if="stage.stage === 'ship'">
      <template v-if="run.repos.length > 0">
        <div
          v-for="repo in run.repos"
          :key="repo.projectId"
          class="fa-line"
          :data-testid="`flow-pr-${repo.projectId}`"
        >
          <span class="fa-label">{{ repo.name }}</span>
          <button
            v-if="repo.prUrl"
            type="button"
            class="ui-chip fa-pr"
            :data-testid="`flow-pr-link-${repo.projectId}`"
            :title="repo.prUrl"
            @click="flow.openPullRequest(run.id, repo.projectId)"
          >
            <Icon name="external" :size="11" />
            PR {{ repo.prId ?? '' }}
          </button>
          <span v-else class="ui-meta">No pull request yet.</span>
        </div>
      </template>
      <div v-else-if="stage.report?.prUrl" class="fa-line">
        <span class="fa-label">Pull request</span>
        <button
          type="button"
          class="ui-chip fa-pr"
          data-testid="flow-pr-link"
          :title="stage.report.prUrl"
          @click="flow.openPullRequest(run.id)"
        >
          <Icon name="external" :size="11" />
          PR {{ stage.report.prId ?? '' }}
        </button>
      </div>
      <div v-else class="ui-empty-line">No pull request yet.</div>
    </template>
  </div>
</template>

<style scoped>
.flow-artefact-view {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.flow-doc {
  max-height: 420px;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-row);
}

.fa-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  padding: 4px 10px;
}

.fa-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
}

.fa-label {
  font: var(--w-em) var(--fs-meta) / 1.2 var(--sans);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-meta);
}

.fa-pr {
  color: var(--green);
}

.fa-unmet {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.flow-progress {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.flow-progress-bar {
  flex: 1;
  height: 6px;
  border-radius: var(--rc);
  background: var(--surface-inset);
  overflow: hidden;
}

.flow-progress-fill {
  height: 100%;
  background: var(--green);
}

.flow-tasks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-meta);
  color: var(--text-mid);
  max-height: 260px;
  overflow-y: auto;
}

.flow-tasks li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.flow-tasks li.done {
  color: var(--text-faint);
  text-decoration: line-through;
}

.flow-gates {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.flow-gate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-meta);
}

.fg-label {
  flex-shrink: 0;
  color: var(--text-body);
}

.fg-detail {
  color: var(--text-meta);
  font-size: var(--fs-micro);
}

.flow-findings-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: var(--fs-ui);
}

.flow-findings-table td {
  padding: var(--sp-2) var(--sp-3) var(--sp-2) 0;
  vertical-align: top;
  line-height: 1.5;
  color: var(--text-body);
  border-top: 1px solid var(--border-soft);
}

.flow-findings-table tr:first-child td {
  border-top: none;
}

.flow-findings-table td:first-child {
  width: 92px;
}

.flow-findings-table td:last-child {
  width: 34%;
  padding-right: 0;
  text-align: right;
}

.fg-where {
  font-size: var(--fs-meta);
  color: var(--text-meta);
  overflow-wrap: anywhere;
}

.fi-acceptance {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-ui);
  line-height: 1.5;
  color: var(--text-body);
}

.flow-code {
  max-height: 320px;
  overflow: auto;
  padding: 10px;
  background: var(--bg-code);
  border: 1px solid var(--border-code);
  border-radius: var(--rc);
  font-family: var(--mono);
  font-size: var(--fs-micro);
  white-space: pre-wrap;
}
</style>
