<script setup lang="ts">
// One clean-view stream event — 1:1 with the design reference: ❯ prompts,
// ✦ SUMMARY cards, approval marker rows, ✗ ERROR cards, ✓ result lines, and
// mono tool/raw lines (FR-014).
import { computed } from 'vue'
import MarkdownText from '@renderer/components/MarkdownText.vue'
import UsageCard from '@renderer/components/UsageCard.vue'
import { parseUsageReport } from '@shared/usage-report'
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

// A /usage response (whichever kind it landed as) renders as a structured card
// with limit meters and dotted lists. Skip while still streaming in.
const usage = computed(() => {
  const text = assistant.value?.partial ? null : (assistant.value?.text ?? summary.value?.text)
  return text ? parseUsageReport(text) : null
})
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
  if (payload.totalCostUsd > 0) parts.push(`$${payload.totalCostUsd.toFixed(2)}`)
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

// Clean view shows only the ACTION + status — never the full command or path
// (those live in the inbox / raw view). Map the tool to a generic verb.
const TOOL_ACTION: Record<string, string> = {
  Bash: 'Ran a command',
  Write: 'Wrote a file',
  Edit: 'Edited a file',
  NotebookEdit: 'Edited a notebook',
  Read: 'Read a file',
  WebFetch: 'Fetched a URL',
  WebSearch: 'Searched the web',
}
function actionVerb(tool: string | undefined | null): string {
  return TOOL_ACTION[tool ?? ''] ?? (tool ? `Used ${tool}` : 'Took an action')
}

const markerLabel = computed(() => {
  const m = marker.value
  if (!m) return ''
  // Plan markers have no tool — keep their (already generic) title.
  if (props.event.kind === 'plan_marker') return m.title
  return actionVerb((m as PermissionMarkerPayload).toolName)
})

// Clean-view tool row: a command-free line — the model's own description if it
// gave one (a human summary, never the command), else a generic verb. The raw
// command and its output live in the raw view only.
const toolLabel = computed(() => {
  const t = tool.value
  if (!t) return ''
  // Bash carries a human `description` alongside the command — surface that
  // (command-free) via a regex (inputPreview is JSON.stringify, possibly
  // truncated, so avoid a fragile JSON.parse). Other tools just get a verb, so
  // a "description" buried in file content can never leak through.
  if (t.toolName === 'Bash') {
    const match = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t.inputPreview ?? '')
    if (match) return match[1].replace(/\\(["\\/])/g, '$1')
  }
  return actionVerb(t.toolName)
})
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

    <!-- /usage response: structured meters + dotted lists instead of prose -->
    <UsageCard v-else-if="usage" :report="usage" />

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

    <!-- tool activity (unswallowed): command-free — action only, no command or
         output dump (the raw view keeps the full ⏺ Bash(cmd) + ⎿ result). -->
    <div v-else-if="tool" class="tool mono">
      <div :class="{ 'tool-error': tool.isError }">
        ⏺ {{ toolLabel }}<span v-if="tool.isError" class="tool-failed"> · failed</span>
      </div>
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
      <span class="marker-title">{{ markerLabel }}</span>
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

/* Your own messages stand out from the narrative: a green-tinted card with an
   accent edge, so scanning back up the stream finds them at a glance. */
.prompt {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  font-size: 12.5px;
  margin-top: 6px;
  padding: 8px 11px;
  background: rgba(52, 211, 153, 0.06);
  border-left: 2px solid var(--green);
  border-radius: var(--rc);
}

/* Light theme uses the remapped forest-green tint. */
html.sb-light .prompt {
  background: rgba(22, 163, 74, 0.06);
}

.caret {
  color: var(--green);
  font-weight: 600;
  line-height: 1.5;
}

.prompt-text {
  color: var(--text-prompt);
  /* Show the message with the spacing/newlines the developer typed. */
  white-space: pre-wrap;
  word-break: break-word;
}

.pending {
  font-size: 10px;
  color: var(--amber);
  border: 1px solid rgba(154, 111, 42, 0.4);
  border-radius: var(--rc);
  padding: 0 6px;
}

.assistant {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-body);
}


.summary-card {
  background: var(--gloss), var(--bg-hover);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-card-alt);
  border-radius: var(--rc);
  padding: 11px 13px;
  box-shadow: var(--elev);
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

.tool-failed {
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
  border-radius: var(--rc);
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
