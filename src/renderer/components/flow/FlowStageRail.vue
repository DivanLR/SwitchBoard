<script setup lang="ts">
import { FLOW_STAGES, FLOW_STAGE_LABELS, type FlowStage, type FlowStageRecord, type FlowStageStatus } from '@shared/domain'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  stages: FlowStageRecord[]
  selected: FlowStage
}>()
const emit = defineEmits<{ (e: 'select', stage: FlowStage): void }>()

function statusOf(stage: FlowStage): FlowStageStatus {
  return props.stages.find((row) => row.stage === stage)?.status ?? 'pending'
}

const STATUS_ICON: Record<FlowStageStatus, string> = {
  pending: 'dot',
  running: 'clock',
  review: 'comment',
  approved: 'check',
  skipped: 'minus',
  failed: 'close',
}
</script>

<template>
  <div class="ui-tabs flow-stage-rail" role="tablist" aria-label="Stages" data-testid="flow-stage-rail">
    <button
      v-for="s in FLOW_STAGES"
      :key="s"
      type="button"
      role="tab"
      class="ui-tab fsr-tab"
      :class="[`is-${statusOf(s)}`, { 'is-selected': s === selected }]"
      :aria-selected="s === selected"
      :data-testid="`flow-stage-${s}`"
      @click="emit('select', s)"
    >
      <Icon :name="STATUS_ICON[statusOf(s)]" :size="10" class="fsr-icon" />
      {{ FLOW_STAGE_LABELS[s] }}
      <span class="fsr-status">{{ statusOf(s) }}</span>
    </button>
  </div>
</template>

<style scoped>
.fsr-icon,
.fsr-status {
  color: var(--text-meta);
}

.fsr-status {
  font-size: var(--fs-meta);
  line-height: 1;
}

.fsr-tab.is-running .fsr-icon,
.fsr-tab.is-running .fsr-status {
  color: var(--green);
}

.fsr-tab.is-review .fsr-icon,
.fsr-tab.is-review .fsr-status {
  color: var(--amber);
}

.fsr-tab.is-failed .fsr-icon,
.fsr-tab.is-failed .fsr-status {
  color: var(--red);
}
</style>
