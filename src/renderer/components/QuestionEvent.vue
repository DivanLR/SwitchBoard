<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@renderer/components/Icon.vue'
import type { QuestionPayload } from '@shared/domain'

const props = defineProps<{ payload: QuestionPayload; eventId: string }>()
const emit = defineEmits<{ (e: 'answer', eventId: string, choice: string): void }>()

const options = computed(() =>
  props.payload.options.map((o) => ({
    label: o.label,
    display: cleanLabel(o.label),
    description: o.description,
    recommended: /\s*\(recommended\)\s*$/i.test(o.label),
  })),
)

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

function cleanLabel(label: string): string {
  return label.replace(/\s*\(recommended\)\s*$/i, '')
}
</script>

<template>
  <div class="ui-card is-warn" data-testid="question-event">
    <div class="ui-kicker card-label warn-label"><Icon name="comment" :size="11" /> QUESTION</div>
    <div class="q-text">{{ payload.text }}</div>
    <div v-if="options.length > 0" class="chips">
      <button
        v-for="option in options"
        :key="option.label"
        class="chip"
        :class="{ chosen: payload.answered && payload.answer === option.label, recommended: option.recommended }"
        :disabled="payload.answered"
        :data-testid="`question-option-${option.display}`"
        :title="option.description"
        @click="choose(option.label)"
      >
        <span v-if="option.recommended" class="rec-badge"><Icon name="star" :size="11" /> Recommended</span>
        {{ option.display }}
      </button>
      <template v-if="!payload.answered">
        <input
          v-if="addingCustom"
          v-model="customText"
          class="custom-input"
          data-testid="question-custom-input"
          autofocus
          placeholder="Type your own answer…"
          @keydown.enter="submitCustom"
          @keydown.esc="cancelCustom"
          @blur="cancelCustom"
        />
        <button
          v-else
          class="chip chip-other"
          data-testid="question-custom"
          @click="addingCustom = true"
        >
          <Icon name="plus" :size="11" /> Other
        </button>
      </template>
    </div>
    <div v-else class="open-hint">Answer through the composer below.</div>
    <div v-if="payload.answered" class="answered" data-testid="question-answered">
<Icon name="check" :size="12" /> Answered: {{ cleanLabel(payload.answer ?? '') }}
    </div>
  </div>
</template>

<style scoped>
.ui-card {
  margin-bottom: 13px;
}

.card-label {
  margin-bottom: 6px;
}

.warn-label {
  color: var(--amber);
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

.chip.recommended {
  border-color: var(--green);
  background: color-mix(in srgb, var(--green) 6%, transparent);
}

.chip.chosen {
  border-color: var(--green);
  color: var(--green);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  opacity: 1;
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
