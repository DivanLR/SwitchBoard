<script setup lang="ts">
import { FLOW_STAGES, FLOW_STAGE_LABELS, type FlowStage, type FlowStageRecord } from '@shared/domain'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  stages: FlowStageRecord[]
  selected: FlowStage
}>()
const emit = defineEmits<{ (e: 'select', stage: FlowStage): void }>()

function statusOf(stage: FlowStage): string {
  return props.stages.find((row) => row.stage === stage)?.status ?? 'pending'
}

const STATUS_ICON: Record<string, string> = {
  pending: 'dot',
  running: 'clock',
  review: 'comment',
  approved: 'check',
  skipped: 'minus',
  failed: 'close',
}
</script>

<template>
  <div class="ui-tabs flow-stage-rail" data-testid="flow-stage-rail">
    <button
      v-for="s in FLOW_STAGES"
      :key="s"
      type="button"
      class="ui-tab fsr-tab"
      :class="[`is-${statusOf(s)}`, { on: s === selected }]"
      :data-testid="`flow-stage-${s}`"
      @click="emit('select', s)"
    >
      <Icon :name="STATUS_ICON[statusOf(s)]" :size="10" />
      {{ FLOW_STAGE_LABELS[s] }}
      <span class="fsr-status">{{ statusOf(s) }}</span>
    </button>
  </div>
</template>

<style scoped>
.flow-stage-rail {
  flex-wrap: wrap;
}

.fsr-tab.is-failed {
  color: var(--red);
}

.fsr-tab.is-approved {
  color: var(--green);
}

.fsr-tab.is-running {
  color: var(--amber);
}

.fsr-status {
  font-size: var(--fs-micro);
  color: var(--text-meta);
}
</style>
