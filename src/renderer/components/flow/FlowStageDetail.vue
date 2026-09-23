<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  FLOW_STAGE_LABELS,
  flowStageActions,
  type FlowRun,
  type FlowStageAction,
  type FlowStageRecord,
  type FlowStageStatus,
} from '@shared/domain'
import { useFlowStore } from '@renderer/stores/flow'
import Icon from '@renderer/components/Icon.vue'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import FlowArtefact from '@renderer/components/flow/FlowArtefact.vue'

const props = defineProps<{ run: FlowRun; stage: FlowStageRecord }>()

const flow = useFlowStore()
const feedback = ref('')
const terminalOpen = ref(true)

watch(
  () => props.stage.stage,
  () => {
    feedback.value = ''
  },
)

const STATUS_PILL: Record<FlowStageStatus, string> = {
  pending: 'done',
  running: 'running',
  review: 'waiting',
  approved: 'done',
  skipped: 'done',
  failed: 'failed',
}

const current = computed(() => !props.run.finishedAt && props.stage.stage === props.run.stage)
const actions = computed(() => flowStageActions(props.run, props.stage))
const buttons = computed(() => actions.value.filter((action) => action !== 'revise'))
const canRevise = computed(() => actions.value.includes('revise'))

function label(action: FlowStageAction): string {
  if (action === 'approve') return props.stage.stage === 'ship' ? 'Finish' : 'Approve'
  if (action === 'fix') return 'Fix findings'
  if (action === 'retry') return 'Retry'
  if (action === 'ship') return 'Raise pull request'
  return props.stage.stage === 'ship' ? 'Finish without a pull request' : 'Skip this stage'
}

function testId(action: FlowStageAction): string {
  return action === 'approve' && props.stage.stage === 'ship' ? 'flow-finish' : `flow-${action}`
}

function perform(action: FlowStageAction): void {
  const runId = props.run.id
  if (action === 'approve') void flow.approve(runId)
  else if (action === 'fix') void flow.fix(runId)
  else if (action === 'retry') void flow.retry(runId)
  else if (action === 'ship') void flow.ship(runId)
  else if (action === 'skip') void flow.skip(runId)
}

async function sendRevise(): Promise<void> {
  const text = feedback.value.trim()
  if (!text) return
  if (await flow.revise(props.run.id, text)) feedback.value = ''
}
</script>

<template>
  <div class="ui-card flow-stage-card" data-testid="flow-stage-detail">
    <div class="fsd-head">
      <span class="fsd-name">{{ FLOW_STAGE_LABELS[stage.stage] }}</span>
      <span class="pill" :class="STATUS_PILL[stage.status]" data-testid="flow-stage-status">{{
        stage.status
      }}</span>
      <span v-if="stage.attempts > 1" class="ui-chip">{{ stage.attempts }} attempts</span>
      <span v-if="!current" class="fsd-readonly" data-testid="flow-stage-readonly">Read only</span>
    </div>

    <div
      v-if="stage.summary"
      :class="stage.status === 'failed' ? 'ui-err-banner' : 'fsd-summary'"
      data-testid="flow-stage-summary"
    >
      {{ stage.summary }}
    </div>

    <FlowArtefact :run="run" :stage="stage" />

    <div v-if="current && stage.sessionId" class="fsd-session">
      <button
        type="button"
        class="btn-quiet fsd-session-toggle"
        data-testid="flow-terminal-toggle"
        :aria-expanded="terminalOpen"
        @click="terminalOpen = !terminalOpen"
      >
        <Icon :name="terminalOpen ? 'minus' : 'plus'" :size="11" />
        {{ terminalOpen ? 'Hide session output' : 'Show session output' }}
      </button>
      <MiniTerminal
        v-if="terminalOpen"
        :session-id="stage.sessionId"
        data-testid="flow-stage-session"
      />
    </div>

    <div v-if="canRevise" class="fsd-revise">
      <input
        v-model="feedback"
        data-testid="flow-feedback"
        placeholder="What should change? Revise runs this stage again with your feedback."
        aria-label="Feedback for this stage"
        @keydown.enter="sendRevise()"
      />
      <button
        type="button"
        class="btn-quiet"
        data-testid="flow-revise"
        :disabled="!feedback.trim() || flow.busy !== null"
        @click="sendRevise()"
      >
        Revise
      </button>
    </div>

    <div v-if="buttons.length > 0" class="fsd-actions" data-testid="flow-stage-actions">
      <button
        v-for="(action, at) in buttons"
        :key="action"
        type="button"
        :class="at === 0 && action !== 'skip' ? 'btn-solid' : 'btn-quiet'"
        :data-testid="testId(action)"
        :disabled="flow.busy !== null"
        @click="perform(action)"
      >
        {{ label(action) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.flow-stage-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.fsd-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.fsd-name {
  font: var(--w-em) var(--fs-ui) / 1.3 var(--sans);
  color: var(--text-strong);
}

.fsd-readonly {
  margin-left: auto;
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.fsd-summary {
  font-size: var(--fs-ui);
  line-height: 1.5;
  color: var(--text-body);
}

.fsd-session {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.fsd-session-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  padding: 4px 10px;
}

.fsd-revise {
  display: flex;
  gap: var(--sp-3);
}

.fsd-revise input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
}

.fsd-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border-soft);
}
</style>
