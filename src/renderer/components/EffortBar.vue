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
const fraction = computed(() => index.value / (EFFORT_LEVELS.length - 1))

function onInput(event: Event): void {
  const next = EFFORT_LEVELS[Number((event.target as HTMLInputElement).value)]
  if (next && next !== props.modelValue) emit('update:modelValue', next)
}
</script>

<template>
  <label class="effort pill" :class="{ max: modelValue === 'max' }" :title="title">
    <Icon v-if="icon" :name="icon" :size="12" />
    <span class="effort-label">{{ label }}</span>
    <span class="effort-track" :style="{ '--fraction': fraction }" :data-testid="`${testid}-track`">
      <span class="effort-fill" :data-testid="`${testid}-fill`" />
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
    </span>
    <span class="effort-value" :data-testid="`${testid}-value`">{{ modelValue }}</span>
  </label>
</template>

<style scoped>
.effort {
  gap: 6px;
  color: var(--text-tab);
  border: 1px solid var(--border-strong);
  cursor: pointer;
}

.effort.max {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 40%, transparent);
}

.effort-track {
  --thumb: 6px;
  position: relative;
  display: inline-block;
  width: 72px;
  height: 4px;
  border-radius: var(--rp);
  background: var(--switch-off);
}

.effort-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: calc(var(--thumb) + var(--fraction) * (100% - var(--thumb)));
  border-radius: inherit;
  background: var(--green);
}

.effort-range {
  position: absolute;
  inset: -4px 0;
  width: 100%;
  height: 12px;
  margin: 0;
  padding: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

.effort-range::-webkit-slider-runnable-track {
  height: 12px;
  background: transparent;
  border: none;
}

.effort-range::-webkit-slider-thumb {
  appearance: none;
  width: var(--thumb);
  height: 12px;
  border: none;
  border-radius: var(--rp);
  background: var(--green);
}

.effort-range:focus-visible {
  outline: 1px solid var(--green);
  outline-offset: 2px;
}

.effort-value {
  min-width: 6ch;
}
</style>
