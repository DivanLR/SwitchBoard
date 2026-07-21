<script setup lang="ts">
// Swallowed block — 1:1 with the design reference:
// "▸ swallowed N lines · kind" toggle, dark expansion box, and a cap that
// defers to the raw view (FR-015/016).
import { computed, ref } from 'vue'
import type { SessionEvent } from '@shared/domain'

const props = defineProps<{ events: SessionEvent[]; noiseKind: string }>()
const emit = defineEmits<{ (e: 'open-raw'): void }>()

const EXPAND_CAP = 100

const expanded = ref(false)
const overCap = computed(() => props.events.length > EXPAND_CAP)
const visibleEvents = computed(() => (expanded.value ? props.events.slice(0, EXPAND_CAP) : []))

function textOf(event: SessionEvent): string {
  const payload = event.payload as { text?: string; toolName?: string; inputPreview?: string }
  if (payload.toolName) return `⏺ ${payload.toolName} ${payload.inputPreview ?? ''}`
  if (typeof payload.text === 'string') return payload.text
  return JSON.stringify(event.payload)
}
</script>

<template>
  <div class="swallowed" data-testid="swallowed-block">
    <div class="toggle mono" @click="expanded = !expanded">
      {{ expanded ? '▾' : '▸' }} Worked quietly for a bit · {{ noiseKind }}
    </div>
    <div v-if="expanded" class="box">
      <div v-for="event in visibleEvents" :key="event.id" class="line mono">{{ textOf(event) }}</div>
      <div v-if="overCap" class="more mono" data-testid="swallowed-open-raw" @click="emit('open-raw')">
        … {{ events.length - EXPAND_CAP }} more lines in Raw view
      </div>
    </div>
  </div>
</template>

<style scoped>
.swallowed {
  margin-bottom: 13px;
}

.toggle {
  font-size: 11.5px;
  color: var(--text-faint);
  cursor: pointer;
  user-select: none;
}

.toggle:hover {
  color: var(--text-mid);
}

.box {
  background: var(--bg-code);
  border: 1px solid var(--border-code);
  border-radius: 10px;
  padding: 9px 12px;
  margin-top: 6px;
  max-height: 400px;
  overflow-y: auto;
}

.line {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-noise);
  white-space: pre-wrap;
  word-break: break-word;
}

.more {
  font-size: 11px;
  color: var(--text-ghost);
  margin-top: 4px;
  cursor: pointer;
}

.more:hover {
  color: var(--text-mid);
}
</style>
