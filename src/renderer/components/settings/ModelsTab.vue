<script setup lang="ts">
import { computed } from 'vue'
import type { ModelChoice, SessionEngine, Settings } from '@shared/domain'
import { engineOf, modelLabel, modelPrice } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'
import Icon from '@renderer/components/Icon.vue'
import EffortBar from '@renderer/components/EffortBar.vue'

defineProps<{ settings: Settings }>()

const store = useSettingsStore()

function save(patch: Partial<Settings>): void {
  void store.save(patch)
}

const claudeModels = computed(() => store.availableModels.filter((m) => engineOf(m) === 'claude'))
const codexModels = computed(() => store.availableModels.filter((m) => engineOf(m) === 'codex'))
const modelChoices = computed<ModelChoice[]>(() => [
  {
    id: 'default',
    label: modelLabel('default'),
    desc: 'Follows your subscription default model',
    price: '—',
  },
  ...claudeModels.value.map((m) => ({
    id: m.id,
    label: modelLabel(m.id),
    desc: m.description,
    price: modelPrice(m.id),
  })),
])

const codexChoices = computed<ModelChoice[]>(() => [
  {
    id: '',
    label: 'CLI default',
    desc: 'Whatever model the Codex CLI is configured to use',
    price: '—',
  },
  ...codexModels.value.map((m) => ({ id: m.id, label: m.label, desc: m.description, price: '—' })),
])

const ENGINE_CHOICES: { id: SessionEngine; label: string; desc: string }[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    desc: 'The full app: permission inbox, plan mode, WSL containers and subagents.',
  },
  {
    id: 'codex',
    label: 'Codex',
    desc: 'The OpenAI Codex CLI. One model, its own sandbox, and no approval prompts routed here.',
  },
]

function setModel(id: string): void {
  save({ model: id })
}
</script>

<template>
  <div class="group">
    <div class="ui-kicker group-label">ENGINE FOR NEW SESSIONS</div>
    <div class="group-desc">
      Which CLI a new session starts on. A Codex session has no permission inbox, no plan mode
      and no container: Codex decides inside its own sandbox, and the session's mode chooses
      which sandbox. Either engine can be picked per session when starting one. Flow stages,
      Tests, Diff and Diagrams always run on Claude Code.
    </div>
    <div class="cards">
      <button
        v-for="e in ENGINE_CHOICES"
        :key="e.id"
        class="ui-card card-opt is-actionable"
        :class="{ sel: settings.defaultEngine === e.id, 'is-selected': settings.defaultEngine === e.id }"
        :data-testid="`default-engine-${e.id}`"
        @click="save({ defaultEngine: e.id })"
      >
        <span class="opt-dot" :class="{ on: settings.defaultEngine === e.id }"></span>
        <div class="opt-body">
          <div class="opt-name">{{ e.label }}</div>
          <div class="opt-sub">{{ e.desc }}</div>
        </div>
      </button>
    </div>
  </div>

  <div class="group">
    <div class="ui-kicker group-label">MODEL</div>
    <div class="group-desc">
      Runs every turn of the session. Fixed once a session starts — switching it
      mid-conversation would throw away the prompt cache and re-bill the whole
      conversation, so a change here reaches only sessions started after it.
    </div>
    <div class="cards">
      <button
        v-for="m in modelChoices"
        :key="m.id"
        class="ui-card card-opt is-actionable"
        :class="{ sel: settings.model === m.id, 'is-selected': settings.model === m.id }"
        :data-testid="`model-${m.id}`"
        @click="setModel(m.id)"
      >
        <span class="opt-dot" :class="{ on: settings.model === m.id }"></span>
        <div class="opt-body">
          <div class="opt-name mono">{{ m.label }}</div>
          <div class="opt-sub">{{ m.desc }}</div>
        </div>
        <span class="opt-price mono">{{ m.price }}</span>
      </button>
    </div>
  </div>

  <div class="group">
    <div class="ui-kicker group-label">CODEX MODEL</div>
    <div class="group-desc">
      The model Codex sessions run, read from the Codex CLI itself.
      <template v-if="codexModels.length === 0">
        No models listed: the Codex CLI was not found, or it did not answer. Install it with
        <span class="mono">npm i -g @openai/codex</span> and sign in with
        <span class="mono">codex login</span>.
      </template>
    </div>
    <div class="cards">
      <button
        v-for="m in codexChoices"
        :key="m.id || 'cli-default'"
        class="ui-card card-opt is-actionable"
        :class="{ sel: settings.codexModel === m.id, 'is-selected': settings.codexModel === m.id }"
        :data-testid="`codex-model-${m.id || 'default'}`"
        @click="save({ codexModel: m.id })"
      >
        <span class="opt-dot" :class="{ on: settings.codexModel === m.id }"></span>
        <div class="opt-body">
          <div class="opt-name mono">{{ m.label }}</div>
          <div class="opt-sub">{{ m.desc }}</div>
        </div>
      </button>
    </div>
  </div>

  <div class="ui-card">
    This applies to every project. New sessions pick it up immediately; running sessions
    keep the model they started with.
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Effort</div>
      <div class="sr-desc">
        How hard the main loop reasons on every turn, for every session. The same bar
        sits in the session header, and a move reaches a running session on its next
        message. Lower it on a small subscription: effort is what empties the usage
        meter.
        <strong class="sr-warn">
          Subagents exist only at max. Below that, every session works in one thread and
          the Agent tool is refused.
        </strong>
      </div>
    </div>
    <EffortBar
      :model-value="settings.effort"
      label="Effort"
      testid="setting-effort"
      @update:model-value="(effort) => save({ effort })"
    />
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Subagent effort</div>
      <div class="sr-desc">
        Only matters once Effort is at max, where subagents exist at all. Sets the
        effort of the worker agent a session delegates independent parts to. At max it
        also switches on divide and conquer: the session is told to split work into
        independent parts and dispatch them to as many workers as the work allows, in
        one batch, instead of working through it alone.
        <strong class="sr-warn">
          Read when a session starts, so it applies from the next session. A session
          started at max carries a <Icon name="fork" :size="11" /> Fan-out pill.
        </strong>
      </div>
    </div>
    <EffortBar
      :model-value="settings.subagentEffort"
      label="Subagents"
      testid="setting-subagent-effort"
      @update:model-value="(subagentEffort) => save({ subagentEffort })"
    />
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Turn summaries</div>
      <div class="sr-desc">
        Style each turn's closing message as a <Icon name="spark" :size="11" /> SUMMARY. Off
        shows it as the raw response — e.g. the full <span class="mono">/usage</span> report
        instead of a summary. Display only; no extra model call.
      </div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.summaries }"
      data-testid="setting-summaries"
      role="switch"
      :aria-checked="settings.summaries"
      @click="save({ summaries: !settings.summaries })"
    >
      <span class="knob"></span>
    </button>
  </div>
</template>

<style scoped>
.sr-warn {
  display: block;
  margin-top: 5px;
  font-weight: 400;
  color: var(--text-body);
}
</style>
