<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FlowRun, FlowStageRecord } from '@shared/domain'
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

const statusChip = computed(() => {
  if (props.stage.status === 'failed') return 'high'
  if (props.stage.status === 'approved' || props.stage.status === 'skipped') return 'low'
  return 'medium'
})

const canApprove = computed(() => props.stage.status === 'review' && props.stage.stage !== 'ship')
const canRetry = computed(() => props.stage.status === 'failed')
const canSkip = computed(() => props.stage.status !== 'approved' && props.stage.status !== 'skipped')
const canFix = computed(
  () =>
    props.stage.stage === 'review' &&
    props.stage.status === 'review' &&
    props.stage.report?.verdict === 'needs_fixes',
)
const canShip = computed(
  () => props.stage.stage === 'ship' && (props.stage.status === 'pending' || props.stage.status === 'failed'),
)
const canRevise = computed(() => props.stage.status === 'review')

async function sendRevise(): Promise<void> {
  const text = feedback.value.trim()
  if (!text) return
  await flow.revise(props.run.id, text)
  feedback.value = ''
}
</script>

<template>
  <div class="ui-card flow-stage-card" data-testid="flow-stage-detail">
    <div class="fi-head">
      <span class="chip-risk" :class="statusChip" data-testid="flow-stage-status">{{ stage.status }}</span>
      <span v-if="stage.attempts > 1" class="ui-chip">{{ stage.attempts }} attempts</span>
    </div>
    <div v-if="stage.summary" class="fi-body" data-testid="flow-stage-summary">{{ stage.summary }}</div>

    <FlowArtefact :run="run" :stage="stage" />

    <div v-if="stage.sessionId" class="flow-terminal">
      <button
        type="button"
        class="btn-quiet flow-terminal-toggle"
        data-testid="flow-terminal-toggle"
        @click="terminalOpen = !terminalOpen"
      >
        <Icon :name="terminalOpen ? 'minus' : 'plus'" :size="11" />
        {{ terminalOpen ? 'Hide session' : 'Show session' }}
      </button>
      <MiniTerminal v-if="terminalOpen" :session-id="stage.sessionId" data-testid="flow-stage-session" />
    </div>

    <div class="flow-actions">
      <button
        v-if="canApprove"
        type="button"
        class="btn-solid"
        data-testid="flow-approve"
        :disabled="flow.busy === 'approve'"
        @click="flow.approve(run.id)"
      >
        Approve
      </button>
      <button
        v-if="canRetry"
        type="button"
        class="btn-outline"
        data-testid="flow-retry"
        :disabled="flow.busy === 'retry'"
        @click="flow.retry(run.id)"
      >
        Retry
      </button>
      <button
        v-if="canSkip"
        type="button"
        class="btn-quiet"
        data-testid="flow-skip"
        :disabled="flow.busy === 'skip'"
        @click="flow.skip(run.id)"
      >
        Skip
      </button>
      <button
        v-if="canFix"
        type="button"
        class="btn-outline"
        data-testid="flow-fix"
        :disabled="flow.busy === 'fix'"
        @click="flow.fix(run.id)"
      >
        Fix findings
      </button>
      <button
        v-if="canShip"
        type="button"
        class="btn-solid"
        data-testid="flow-ship"
        :disabled="flow.busy === 'ship'"
        @click="flow.ship(run.id)"
      >
        Raise pull request
      </button>
      <button
        v-if="run.status !== 'done' && run.status !== 'cancelled'"
        type="button"
        class="btn-quiet"
        data-testid="flow-cancel"
        @click="flow.cancel(run.id)"
      >
        Cancel
      </button>
    </div>

    <div v-if="canRevise" class="flow-revise">
      <input
        v-model="feedback"
        class="fp-input"
        data-testid="flow-feedback"
        placeholder="Revise per this feedback…"
        @keydown.enter="sendRevise()"
      />
      <button type="button" class="btn-quiet" data-testid="flow-revise" @click="sendRevise()">Revise</button>
    </div>
  </div>
</template>

<style scoped>
.flow-stage-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fi-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fi-body {
  font-size: var(--fs-meta);
  color: var(--text-mid);
  line-height: 1.5;
}

.flow-terminal {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.flow-terminal-toggle {
  align-self: flex-start;
  font-size: var(--fs-micro);
}

.flow-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.flow-revise {
  display: flex;
  gap: 8px;
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
</style>
