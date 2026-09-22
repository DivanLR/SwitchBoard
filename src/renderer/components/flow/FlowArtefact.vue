<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FlowRun, FlowStageRecord } from '@shared/domain'
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

async function loadMarkdown(kind: 'spec' | 'plan'): Promise<void> {
  markdown.value = null
  const result = await flow.artefact(props.run.id, props.stage.stage, kind)
  markdown.value = result?.content ?? null
}

async function loadTasks(): Promise<void> {
  tasksText.value = null
  const result = await flow.artefact(props.run.id, props.stage.stage, 'tasks')
  tasksText.value = result?.content ?? null
}

async function loadPostman(): Promise<void> {
  postman.value = null
  const result = await flow.artefact(props.run.id, props.stage.stage, 'postman')
  postman.value = result ?? 'missing'
}

watch(
  () => [props.run.id, props.stage.stage] as const,
  ([, stage]) => {
    showTasks.value = false
    tasksText.value = null
    postman.value = null
    if (stage === 'spec') void loadMarkdown('spec')
    else if (stage === 'plan') void loadMarkdown('plan')
    else if (stage === 'build') void loadTasks()
    else markdown.value = null
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
      <MarkdownText v-if="markdown" :text="markdown" data-testid="flow-artefact-markdown" />
      <div v-else class="ui-empty-sub">No spec.md written yet.</div>
      <template v-if="stage.stage === 'plan'">
        <div v-if="progress" class="flow-progress" data-testid="flow-tasks-progress">
          <div class="flow-progress-bar">
            <div class="flow-progress-fill" :style="{ width: `${(progress.done / progress.total) * 100}%` }"></div>
          </div>
          <span class="ui-chip">{{ progress.done }} / {{ progress.total }} tasks</span>
        </div>
        <button type="button" class="btn-outline" data-testid="flow-tasks-toggle" @click="toggleTasks()">
          {{ showTasks ? 'Hide tasks' : 'View tasks' }}
        </button>
        <ul v-if="showTasks && taskItems.length > 0" class="flow-tasks" data-testid="flow-tasks-checklist">
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
          <div class="flow-progress-fill" :style="{ width: `${(progress.done / progress.total) * 100}%` }"></div>
        </div>
        <span class="ui-chip">{{ progress.done }} / {{ progress.total }} tasks</span>
      </div>
      <ul v-if="taskItems.length > 0" class="flow-tasks" data-testid="flow-tasks-checklist">
        <li v-for="(task, at) in taskItems" :key="at" :class="{ done: task.done }">
          <Icon :name="task.done ? 'check' : 'circle'" :size="11" />
          {{ task.label }}
        </li>
      </ul>
      <div v-else class="ui-empty-sub">No tasks.md yet.</div>
    </template>

    <template v-else-if="stage.stage === 'test'">
      <div v-if="stage.report?.verify?.suites.length" class="flow-gates" data-testid="flow-test-gates">
        <div v-for="suite in stage.report.verify.suites" :key="suite.id" class="flow-gate-row">
          <span class="chip-risk" :class="suite.status === 'pass' ? 'low' : suite.status === 'fail' ? 'high' : 'medium'">
            {{ suite.status }}
          </span>
          <span class="fg-label">{{ suite.label }}</span>
          <span class="fg-detail">{{ suite.detail }}</span>
        </div>
      </div>
      <div v-else class="ui-empty-sub">No test report yet.</div>
      <button type="button" class="btn-outline" data-testid="flow-postman-load" @click="loadPostman()">
        View Postman collection
      </button>
      <pre v-if="postman && postman !== 'missing'" class="flow-code" data-testid="flow-postman-content">{{ postman.content }}</pre>
      <div v-else-if="postman === 'missing'" class="ui-empty-sub" data-testid="flow-postman-missing">
        No Postman collection for this feature.
      </div>
    </template>

    <template v-else-if="stage.stage === 'review'">
      <div v-if="stage.report?.verdict" class="ui-chip" data-testid="flow-review-verdict">
        verdict: {{ stage.report.verdict }}
      </div>
      <table v-if="stage.report?.findings?.length" class="flow-findings-table" data-testid="flow-findings">
        <tbody>
          <tr v-for="(finding, at) in stage.report.findings" :key="at">
            <td><span class="chip-risk" :class="finding.severity === 'must_fix' ? 'high' : finding.severity === 'should_fix' ? 'medium' : 'low'">{{ finding.severity }}</span></td>
            <td>{{ finding.what }}</td>
            <td class="mono fg-detail">{{ finding.file }}{{ finding.line ? `:${finding.line}` : '' }}</td>
          </tr>
        </tbody>
      </table>
      <ul v-if="stage.report?.unmet?.length" class="fi-acceptance" data-testid="flow-unmet">
        <li v-for="line in stage.report.unmet" :key="line">{{ line }}</li>
      </ul>
      <div v-if="!stage.report?.findings?.length && !stage.report?.unmet?.length" class="ui-empty-sub">
        No findings and every acceptance criterion is met.
      </div>
    </template>

    <template v-else-if="stage.stage === 'ship'">
      <a v-if="stage.report?.prUrl" :href="stage.report.prUrl" class="ui-chip" data-testid="flow-pr-link">
        <Icon name="external" :size="11" /> PR {{ stage.report.prId }}
      </a>
      <div v-else class="ui-empty-sub">No pull request yet.</div>
    </template>
  </div>
</template>

<style scoped>
.flow-artefact-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.flow-artefact-view > .ui-chip,
.flow-artefact-view > .btn-outline {
  align-self: flex-start;
}

.flow-progress {
  display: flex;
  align-items: center;
  gap: 10px;
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
  font-size: var(--fs-meta);
}

.flow-findings-table td {
  padding: 4px 8px 4px 0;
  vertical-align: top;
  color: var(--text-body);
}

.flow-findings-table td:first-child {
  width: 76px;
}

.flow-findings-table td:last-child {
  width: 240px;
  padding-right: 0;
  text-align: right;
  color: var(--text-meta);
}

.fi-acceptance {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-micro);
  color: var(--text-meta);
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
