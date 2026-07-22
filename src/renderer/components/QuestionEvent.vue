<script setup lang="ts">
// ? QUESTION card — 1:1 with the design reference: amber-tinted card with
// clickable option chips; answers submit to the session (FR-020).
import { ref } from 'vue'
import type { QuestionPayload } from '@shared/domain'

const props = defineProps<{ payload: QuestionPayload; eventId: string }>()
const emit = defineEmits<{ (e: 'answer', eventId: string, choice: string): void }>()

// A free-text answer is always allowed alongside the offered options; the
// broker stores whatever string is sent, no need to match a listed choice.
const addingCustom = ref(false)
const customText = ref('')

function choose(label: string): void {
  if (props.payload.answered) return
  emit('answer', props.eventId, label)
}

function submitCustom(): void {
  const text = customText.value.trim()
  if (!text) return
  emit('answer', props.eventId, text)
  addingCustom.value = false
  customText.value = ''
}

function cancelCustom(): void {
  addingCustom.value = false
  customText.value = ''
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
      <template v-if="!payload.answered">
        <input
          v-if="addingCustom"
          v-model="customText"
          class="custom-input mono"
          data-testid="question-custom-input"
          autofocus
          placeholder="Type your own answer…"
          @keydown.enter="submitCustom"
          @keydown.esc="cancelCustom"
          @blur="cancelCustom"
        />
        <button
          v-else
          class="chip chip-other mono"
          data-testid="question-custom"
          @click="addingCustom = true"
        >
          + Other
        </button>
      </template>
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

.chip-other {
  border-style: dashed;
  color: var(--text-faint);
}

.custom-input {
  font-size: 11.5px;
  color: var(--text-strong);
  background: var(--bg);
  border: 1px solid var(--green);
  border-radius: 10px;
  padding: 5px 11px;
  outline: none;
  min-width: 180px;
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
