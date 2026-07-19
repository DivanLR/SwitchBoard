<script setup lang="ts">
// One clean-view stream event — 1:1 with the design reference: ❯ prompts,
// ✦ SUMMARY cards, approval marker rows, ✗ ERROR cards, ✓ result lines, and
// mono tool/raw lines (FR-014).
import { computed } from 'vue'
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

const props = defineProps<{ event: SessionEvent }>()
const emit = defineEmits<{ (e: 'open-inbox', requestId: string): void }>()

const kind = computed(() => props.event.kind)
const p = computed(() => props.event.payload)

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

const markerStatus = computed(() => {
  if (kind.value !== 'permission_marker' && kind.value !== 'plan_marker') return null
  return (p.value as PermissionMarkerPayload | PlanMarkerPayload).status
})

const markerChipLabel: Record<string, string> = {
  pending: 'needs approval',
  approved: 'approved',
  denied: 'denied',
  expired: 'expired',
  rule_approved: 'auto-approved',
}
</script>

<template>
  <div class="event" :data-testid="`stream-event-${kind}`" :data-event-id="event.id">
    <!-- ❯ prompt -->
    <div v-if="kind === 'prompt'" class="prompt mono">
      <span class="caret">❯</span>
      <span class="prompt-text">{{ (p as PromptPayload).text }}</span>
      <span v-if="(p as PromptPayload).pending" class="pending mono" data-testid="prompt-pending">
        queued
      </span>
    </div>

    <!-- assistant narrative -->
    <div v-else-if="kind === 'assistant_text'" class="assistant">
      {{ (p as AssistantTextPayload).text
      }}<span v-if="(p as AssistantTextPayload).partial" class="blink" style="color: var(--green)">▊</span>
    </div>

    <!-- ✦ SUMMARY card -->
    <div v-else-if="kind === 'summary'" class="summary-card">
      <div class="card-label mono"><span style="color: var(--green)">✦</span> SUMMARY</div>
      <div class="card-body">{{ (p as SummaryPayload).text }}</div>
    </div>

    <!-- tool activity (unswallowed) -->
    <div v-else-if="kind === 'tool_activity'" class="tool mono">
      <div :class="{ 'tool-error': (p as ToolActivityPayload).isError }">
        ⏺ {{ (p as ToolActivityPayload).toolName }} {{ (p as ToolActivityPayload).inputPreview }}
      </div>
      <div v-if="(p as ToolActivityPayload).resultPreview" class="tool-result">
        ⎿ {{ (p as ToolActivityPayload).resultPreview }}
      </div>
    </div>

    <!-- permission / plan markers -->
    <div
      v-else-if="kind === 'permission_marker' || kind === 'plan_marker'"
      class="marker mono"
      :data-testid="kind === 'plan_marker' ? 'plan-marker' : 'permission-marker'"
    >
      <span class="chip-marker" :class="markerStatus ?? ''">
        {{ kind === 'plan_marker' && markerStatus === 'pending' ? 'plan approval' : markerChipLabel[markerStatus ?? ''] }}
      </span>
      <span class="marker-title">{{ (p as PermissionMarkerPayload).title }}</span>
      <button
        v-if="markerStatus === 'pending'"
        class="review-link mono"
        data-testid="review-in-inbox"
        @click="emit('open-inbox', (p as PermissionMarkerPayload).requestId)"
      >
        review in inbox →
      </button>
    </div>

    <!-- ✗ ERROR card -->
    <div v-else-if="kind === 'error'" class="error-card" data-testid="error-event">
      <div class="card-label mono error-label">✗ ERROR</div>
      <div class="error-body mono">{{ (p as ErrorPayload).text }}</div>
    </div>

    <!-- ✓ result -->
    <div v-else-if="kind === 'result'" class="done mono" data-testid="result-event">
      ✓ {{ resultLabel(p as ResultPayload) }}
    </div>

    <!-- raw output (unswallowed) -->
    <div v-else class="raw mono">{{ (p as { text?: string }).text }}</div>
  </div>
</template>

<style scoped>
.event {
  margin-bottom: 13px;
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
  border: 1px solid rgba(232, 180, 90, 0.4);
  border-radius: 4px;
  padding: 0 6px;
}

.assistant {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-body);
  text-wrap: pretty;
  white-space: pre-wrap;
  word-break: break-word;
}

.blink {
  animation: sbBlink 1.1s steps(1) infinite;
}

.summary-card {
  background: var(--bg-card);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
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
  text-wrap: pretty;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool {
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
  border: 1px solid rgba(224, 108, 85, 0.4);
  background: rgba(224, 108, 85, 0.05);
  border-radius: 8px;
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
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-noise);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
