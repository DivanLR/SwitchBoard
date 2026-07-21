<script setup lang="ts">
// One clean-view stream event — 1:1 with the design reference: ❯ prompts,
// ✦ SUMMARY cards, approval marker rows, ✗ ERROR cards, ✓ result lines, and
// mono tool/raw lines (FR-014).
import { computed } from 'vue'
import MarkdownText from '@renderer/components/MarkdownText.vue'
import type {
  AssistantTextPayload,
  ErrorPayload,
  PermissionMarkerPayload,
  PlanMarkerPayload,
  PromptPayload,
  ResultPayload,
  SessionEvent,
  SummaryPayload,
  ToolActivityPayload,
} from '@shared/domain'

const props = defineProps<{ event: SessionEvent; stamps?: boolean }>()
const emit = defineEmits<{ (e: 'open-inbox', requestId: string): void }>()

const kind = computed(() => props.event.kind)

/** HH:MM stamp shown when the Timestamps setting is on. */
const stamp = computed(() => {
  if (!props.stamps) return null
  const d = new Date(props.event.createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
})

// Per-kind typed accessors: narrow on `kind` once here rather than casting the
// payload inline throughout the template.
const prompt = computed(() =>
  props.event.kind === 'prompt' ? (props.event.payload as PromptPayload) : null,
)
const assistant = computed(() =>
  props.event.kind === 'assistant_text' ? (props.event.payload as AssistantTextPayload) : null,
)
const summary = computed(() =>
  props.event.kind === 'summary' ? (props.event.payload as SummaryPayload) : null,
)
const tool = computed(() =>
  props.event.kind === 'tool_activity' ? (props.event.payload as ToolActivityPayload) : null,
)
const marker = computed(() =>
  props.event.kind === 'permission_marker' || props.event.kind === 'plan_marker'
    ? (props.event.payload as PermissionMarkerPayload | PlanMarkerPayload)
    : null,
)
const errorPayload = computed(() =>
  props.event.kind === 'error' ? (props.event.payload as ErrorPayload) : null,
)
const result = computed(() =>
  props.event.kind === 'result' ? (props.event.payload as ResultPayload) : null,
)
const rawText = computed(() => (props.event.payload as { text?: string }).text ?? '')

// The SDK can emit empty text blocks (message-mapper), producing events with no
// visible content. Rendering one leaves an orphan timestamp beside blank space,
// so such events are dropped from the clean stream — and with them, the stamp.
const hasContent = computed(() => {
  if (prompt.value) return Boolean(prompt.value.text?.trim())
  if (assistant.value) return Boolean(assistant.value.text?.trim())
  if (summary.value) return Boolean(summary.value.text?.trim())
  if (tool.value || marker.value || errorPayload.value || result.value) return true
  return Boolean(rawText.value.trim())
})

function resultLabel(payload: ResultPayload): string {
  const parts: string[] = ['turn complete']
  if (payload.durationMs > 0) parts.push(`${(payload.durationMs / 1000).toFixed(1)}s`)
  if (payload.totalCostUsd > 0) parts.push(`$${payload.totalCostUsd.toFixed(4)}`)
  const usage = payload.usage
  if (usage.inputTokens || usage.outputTokens) {
    parts.push(`${(usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)} tok`)
  }
  return parts.join(' · ')
}

const markerStatus = computed(() => marker.value?.status ?? null)

const markerChipLabel: Record<string, string> = {
  pending: 'Needs approval',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
  rule_approved: 'Auto-approved',
}
</script>

<template>
  <div v-if="hasContent" class="event" :class="{ stamped: stamp }" :data-testid="`stream-event-${kind}`" :data-event-id="event.id">
    <span v-if="stamp" class="stamp mono" data-testid="event-stamp">{{ stamp }}</span>
    <!-- ❯ prompt -->
    <div v-if="prompt" class="prompt mono">
      <span class="caret">❯</span>
      <span class="prompt-text">{{ prompt.text }}</span>
      <span v-if="prompt.pending" class="pending mono" data-testid="prompt-pending"> queued </span>
    </div>

    <!-- assistant narrative (Markdown-formatted) -->
    <div v-else-if="assistant" class="assistant">
      <MarkdownText :text="assistant.text" />
      <span v-if="assistant.partial" class="blink" style="color: var(--green)">▊</span>
    </div>

    <!-- ✦ SUMMARY card -->
    <div v-else-if="summary" class="summary-card">
      <div class="card-label mono"><span style="color: var(--green)">✦</span> SUMMARY</div>
      <div class="card-body"><MarkdownText :text="summary.text" /></div>
    </div>

    <!-- tool activity (unswallowed) -->
    <div v-else-if="tool" class="tool mono">
      <div :class="{ 'tool-error': tool.isError }">⏺ {{ tool.toolName }} {{ tool.inputPreview }}</div>
      <div v-if="tool.resultPreview" class="tool-result">⎿ {{ tool.resultPreview }}</div>
    </div>

    <!-- permission / plan markers -->
    <div
      v-else-if="marker"
      class="marker mono"
      :data-testid="kind === 'plan_marker' ? 'plan-marker' : 'permission-marker'"
    >
      <span class="chip-marker" :class="markerStatus ?? ''">
        {{
          kind === 'plan_marker' && markerStatus === 'pending'
            ? 'Plan approval'
            : markerChipLabel[markerStatus ?? '']
        }}
      </span>
      <span class="marker-title">{{ marker.title }}</span>
      <button
        v-if="markerStatus === 'pending'"
        class="review-link mono"
        data-testid="review-in-inbox"
        @click="emit('open-inbox', marker.requestId)"
      >
        Review in inbox →
      </button>
    </div>

    <!-- ✗ ERROR card -->
    <div v-else-if="errorPayload" class="error-card" data-testid="error-event">
      <div class="card-label mono error-label">✗ ERROR</div>
      <div class="error-body mono">{{ errorPayload.text }}</div>
    </div>

    <!-- ✓ result -->
    <div v-else-if="result" class="done mono" data-testid="result-event">
      ✓ {{ resultLabel(result) }}
    </div>

    <!-- raw output (unswallowed) -->
    <div v-else class="raw mono">{{ rawText }}</div>
  </div>
</template>

<style scoped>
.event {
  margin-bottom: 13px;
}

/* Timestamps setting: dim HH:MM gutter to the left of the event. */
.event.stamped {
  display: grid;
  grid-template-columns: 38px 1fr;
  gap: 8px;
  align-items: baseline;
}

.stamp {
  font-size: 10px;
  color: var(--text-ghost);
  white-space: nowrap;
}

.prompt {
  display: flex;
  gap: 9px;
  align-items: baseline;
  font-size: 12.5px;
  margin-top: 6px;
}

.caret {
  color: var(--green);
  font-weight: 700;
}

.prompt-text {
  color: var(--text-prompt);
}

.pending {
  font-size: 10px;
  color: var(--amber);
  border: 1px solid rgba(154, 111, 42, 0.4);
  border-radius: 10px;
  padding: 0 6px;
}

.assistant {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-body);
}


.summary-card {
  background: var(--bg-card);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 11px 13px;
}

.card-label {
  font-size: 10px;
  letter-spacing: 0.13em;
  color: var(--text-label);
  margin-bottom: 6px;
}

.card-body {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-body);
}

.tool {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-noise);
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-error {
  color: var(--red);
}

.tool-result {
  padding-left: 16px;
  max-height: 96px;
  overflow: hidden;
}

.marker {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
  flex-wrap: wrap;
}

.marker-title {
  color: var(--text-mid);
}

.review-link {
  color: var(--green);
  font-size: 11px;
}

.review-link:hover {
  text-decoration: underline;
}

.error-card {
  border: 1px solid rgba(143, 59, 44, 0.4);
  background: rgba(143, 59, 44, 0.05);
  border-radius: 10px;
  padding: 11px 13px;
}

.error-label {
  color: var(--red);
}

.error-body {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-body);
  white-space: pre-wrap;
  word-break: break-word;
}

.done {
  font-size: 12.5px;
  color: var(--green);
}

.raw {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-noise);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
