<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { toRawLines } from '@shared/stream-lines'
import { pendingQuestion } from '@shared/inline-question'
import QuestionEvent from '@renderer/components/QuestionEvent.vue'
import { useActiveSessionStore } from '@renderer/stores/activeSession'

const props = defineProps<{
  sessionId: string
  label?: string
}>()

const active = useActiveSessionStore()
const boxEl = ref<HTMLElement | null>(null)

watch(
  () => props.sessionId,
  (id, previous) => {
    if (previous) active.unwatchTail(previous)
    if (id) void active.watchTail(id)
  },
  { immediate: true },
)

onUnmounted(() => active.unwatchTail(props.sessionId))

const lines = computed(() => toRawLines(active.tails[props.sessionId] ?? [], false))

const answered = ref<string | null>(null)
const question = computed(() => pendingQuestion(active.tails[props.sessionId] ?? [], answered.value))

function answer(eventId: string, choice: string): void {
  answered.value = eventId
  void active.sendTo(props.sessionId, choice.replace(/\s*\(recommended\)\s*$/i, ''))
}

watch(lines, () => {
  requestAnimationFrame(() => {
    if (boxEl.value) boxEl.value.scrollTop = boxEl.value.scrollHeight
  })
})
</script>

<template>
  <div class="mini-term" data-testid="mini-terminal">
    <div v-if="label" class="mt-label mono">{{ label }}</div>
    <div ref="boxEl" class="mt-box mono" role="log" aria-live="polite">
      <div v-if="lines.length === 0" class="mt-wait" data-testid="mini-terminal-empty">
        waiting for output…
      </div>
      <div v-for="line in lines" :key="line.key" class="mt-line" data-testid="mini-terminal-line">
        {{ line.text }}
      </div>
    </div>
    <QuestionEvent
      v-if="question"
      :event-id="question.eventId"
      :payload="question.payload"
      data-testid="mini-terminal-question"
      @answer="answer"
    />
  </div>
</template>

<style scoped>
.mini-term {
  margin-top: 8px;
}

.mt-label {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  margin-bottom: 4px;
}

.mt-box {
  height: 118px;
  overflow-y: auto;
  padding: 6px 8px;
  background: var(--bg-code);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  font-size: var(--fs-micro);
  line-height: 1.45;
}

.mt-line {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-dim);
}

.mt-wait {
  color: var(--text-faint);
}
</style>
