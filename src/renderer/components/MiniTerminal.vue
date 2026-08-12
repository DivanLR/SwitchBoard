<script setup lang="ts">
// A few lines of a session's output, shown where the work was asked for.
//
// A section dispatches to a background session the developer never sees, so a
// verify pass, an API run or a diagram request looked identical to nothing
// happening for however long it took. The events were already crossing the wire
// live the whole time — the store simply dropped any that did not belong to the
// open conversation (see activeSession's watchTail).
//
// Deliberately a TAIL and not a second stream view: it exists to show that
// something is happening and what it is doing now. Anything worth reading back
// through is in the session itself, whole and paged.
import { computed, onUnmounted, ref, watch } from 'vue'
import { toRawLines } from '@shared/stream-lines'
import { useActiveSessionStore } from '@renderer/stores/activeSession'

const props = defineProps<{
  sessionId: string
  /** Shown above the box, e.g. "verifying" — omit for no heading. */
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

// No timestamps: at this size the stamp column costs more width than the line it
// dates, and the answer to "when" is "now" — that is the whole point of a tail.
const lines = computed(() => toRawLines(active.tails[props.sessionId] ?? [], false))

// Pinned to the newest line, always. Unlike the main stream there is no reading
// position to preserve here: a tail nobody scrolls is a tail showing the past.
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

/* Short and fixed: a tail that grows with its content pushes the panel it sits
   in around while the developer is reading the rest of it. */
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
