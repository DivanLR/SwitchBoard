<script setup lang="ts">
import { computed } from 'vue'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/domain'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  modelValue: EffortLevel
  label: string
  testid: string
  title?: string
  icon?: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: EffortLevel): void }>()

const index = computed(() => Math.max(0, EFFORT_LEVELS.indexOf(props.modelValue)))

function onInput(event: Event): void {
  const next = EFFORT_LEVELS[Number((event.target as HTMLInputElement).value)]
  if (next && next !== props.modelValue) emit('update:modelValue', next)
}
</script>

<template>
  <label class="effort mono" :class="{ max: modelValue === 'max' }" :title="title">
    <Icon v-if="icon" :name="icon" :size="12" />
    <span class="effort-label">{{ label }}</span>
    <input
      type="range"
      class="effort-range"
      min="0"
      :max="EFFORT_LEVELS.length - 1"
      step="1"
      :value="index"
      :data-testid="testid"
      :aria-label="`${label} effort`"
      :aria-valuetext="modelValue"
      @input="onInput"
    />
    <span class="effort-value" :data-testid="`${testid}-value`">{{ modelValue }}</span>
  </label>
</template>

<style scoped>
.effort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: var(--fs-meta);
  color: var(--text-tab);
  padding: 2px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--rp);
  cursor: pointer;
}

.effort.max {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 40%, transparent);
}

.effort-range {
  width: 72px;
  height: 12px;
  margin: 0;
  accent-color: var(--green);
  cursor: pointer;
}

.effort-value {
  min-width: 6ch;
}
</style>
