<script setup lang="ts">
// ? QUESTION card — 1:1 with the design reference: amber-tinted card with
// clickable option chips; answers submit to the session (FR-020).
import type { QuestionPayload } from '@shared/domain'

const props = defineProps<{ payload: QuestionPayload; eventId: string }>()
const emit = defineEmits<{ (e: 'answer', eventId: string, choice: string): void }>()

function choose(label: string): void {
  if (props.payload.answered) return
  emit('answer', props.eventId, label)
}
</script>

<template>
  <div class="question" data-testid="question-event">
    <div class="q-label mono">? QUESTION</div>
    <div class="q-text">{{ payload.text }}</div>
    <div v-if="payload.options.length > 0" class="chips">
      <button
        v-for="option in payload.options"
        :key="option.label"
        class="chip mono"
        :class="{ chosen: payload.answered && payload.answer === option.label }"
        :disabled="payload.answered"
        :data-testid="`question-option-${option.label}`"
        :title="option.description"
        @click="choose(option.label)"
      >
        {{ option.label }}
      </button>
    </div>
    <div v-else class="open-hint mono">Answer through the composer below.</div>
    <div v-if="payload.answered" class="answered mono" data-testid="question-answered">
      ✓ Answered: {{ payload.answer }}
    </div>
  </div>
</template>

<style scoped>
.question {
  border: 1px solid rgba(154, 111, 42, 0.35);
  background: rgba(154, 111, 42, 0.04);
  border-radius: 10px;
  padding: 11px 13px;
  margin-bottom: 13px;
}

.q-label {
  font-size: 10px;
  letter-spacing: 0.13em;
  color: var(--amber);
  margin-bottom: 6px;
}

.q-text {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-body);
  text-wrap: pretty;
}

.chips {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.chip {
  font-size: 11.5px;
  color: var(--text-body);
  background: var(--bg-chip);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 5px 11px;
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  border-color: var(--green);
  color: var(--text-strong);
}

.chip:disabled {
  cursor: default;
  opacity: 0.6;
}

.chip.chosen {
  border-color: var(--green);
  color: var(--green);
  opacity: 1;
}

.open-hint {
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 8px;
}

.answered {
  margin-top: 8px;
  font-size: 11px;
  color: var(--green);
}
</style>
