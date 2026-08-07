<script setup lang="ts">
// ? QUESTION card — 1:1 with the design reference: amber-tinted card with
// clickable option chips; answers submit to the session (FR-020).
import { computed, ref } from 'vue'
import type { QuestionPayload } from '@shared/domain'

const props = defineProps<{ payload: QuestionPayload; eventId: string }>()
const emit = defineEmits<{ (e: 'answer', eventId: string, choice: string): void }>()

// The session marks its recommended option by appending "(Recommended)" to the
// label (the AskUserQuestion convention). Surface that as a badge and show a
// clean label, but keep the original label as the value sent back so it matches.
const options = computed(() =>
  props.payload.options.map((o) => ({
    label: o.label,
    display: cleanLabel(o.label),
    description: o.description,
    recommended: /\s*\(recommended\)\s*$/i.test(o.label),
  })),
)

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

// Drop the "(Recommended)" marker for display (the confirmation line and chips
// show the clean label; the raw value with the marker is what's stored/sent).
function cleanLabel(label: string): string {
  return label.replace(/\s*\(recommended\)\s*$/i, '')
}
</script>

<template>
  <div class="question" data-testid="question-event">
    <div class="q-label mono">? QUESTION</div>
    <div class="q-text">{{ payload.text }}</div>
    <div v-if="options.length > 0" class="chips">
      <button
        v-for="option in options"
        :key="option.label"
        class="chip mono"
        :class="{ chosen: payload.answered && payload.answer === option.label, recommended: option.recommended }"
        :disabled="payload.answered"
        :data-testid="`question-option-${option.display}`"
        :title="option.description"
        @click="choose(option.label)"
      >
        <span v-if="option.recommended" class="rec-badge">★ Recommended</span>
        {{ option.display }}
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
    <div v-else class="open-hint">Answer through the composer below.</div>
    <div v-if="payload.answered" class="answered mono" data-testid="question-answered">
      ✓ Answered: {{ cleanLabel(payload.answer ?? '') }}
    </div>
  </div>
</template>

<style scoped>
.question {
  border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
  background: color-mix(in srgb, var(--amber) 4%, transparent);
  border-radius: var(--rc);
  padding: 11px 13px;
  margin-bottom: 13px;
}

.q-label {
  font-size: var(--fs-micro);
  letter-spacing: 0.13em;
  color: var(--amber);
  margin-bottom: 6px;
}

.q-text {
  font-size: var(--fs-body);
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
  font-size: var(--fs-meta);
  color: var(--text-body);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  padding: 5px 11px;
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  border-color: var(--green);
  color: var(--text-strong);
}

.chip.chip-other:hover {
  border-color: var(--border-strong);
  color: var(--text-mid);
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

/* Recommended option: greener chrome + a small star badge. */
.chip.recommended {
  border-color: var(--green);
}

.rec-badge {
  display: inline-block;
  margin-right: 7px;
  font-size: var(--fs-micro);
  letter-spacing: 0.04em;
  color: var(--green);
  text-transform: uppercase;
}

.chip-other {
  border-style: dashed;
  color: var(--text-faint);
}

.custom-input {
  font-size: var(--fs-meta);
  color: var(--text-strong);
  background: var(--bg);
  border: 1px solid var(--green);
  border-radius: var(--rc);
  padding: 5px 11px;
  outline: none;
  min-width: 180px;
}

.open-hint {
  font-size: var(--fs-meta);
  color: var(--text-faint);
  margin-top: 8px;
}

.answered {
  margin-top: 8px;
  font-size: var(--fs-meta);
  color: var(--green);
}
</style>
