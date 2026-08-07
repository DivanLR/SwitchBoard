<script setup lang="ts">
// Settings modal — 1:1 with the design reference: header, left icon-tab rail
// (Models / This project / Terminals / General) with a Plan/Build footer,
// card + toggle + segmented controls, and a "Changes apply immediately · Done"
// footer. State and transport live in the settings store.
import { useTemplateRef, computed, onMounted, ref, watch } from 'vue'
import { useModal } from '@renderer/composables/useModal'
import { MATCHER_KIND_LABEL, useAllowedRules } from '@renderer/composables/useAllowedRules'
import type { ModelChoice, SessionMode, Settings, TerseLevel } from '@shared/domain'
import { modelLabel, modelPrice, SESSION_MODES } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'
import { useProjectsStore } from '@renderer/stores/projects'
import { useUpdatesStore } from '@renderer/stores/updates'

// The prop deliberately omits 'mcp' even though the Tab union below includes it:
// the MCP tab is reachable by clicking, but no caller opens the panel straight
// onto it, so accepting the value would be a promise nothing keeps.
const props = defineProps<{ initialTab?: 'models' | 'proj' | 'allowed' | 'term' | 'gen' }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// Escape closes, Tab stays inside, focus returns to the opener on close.
const dialogEl = useTemplateRef<HTMLElement>('dialog')
useModal(dialogEl, () => emit('close'))
const store = useSettingsStore()
const projects = useProjectsStore()
const updates = useUpdatesStore()
const settings = computed(() => store.settings)

// No 'rules' tab. The risk and noise engines still run on every tool call and
// every streamed event; what is gone is the editor for overriding them, which
// nobody used and which cost a whole tab in a rail of seven.
type Tab = 'models' | 'proj' | 'mcp' | 'allowed' | 'term' | 'gen'
const tab = ref<Tab>(props.initialTab ?? 'models')
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'models', label: 'Models', icon: '✦' },
  { id: 'proj', label: 'This project', icon: '▣' },
  { id: 'mcp', label: 'MCP', icon: '⛁' },
  { id: 'allowed', label: 'Allowed list', icon: '✓' },
  { id: 'term', label: 'Terminals', icon: '❯' },
  { id: 'gen', label: 'General', icon: '⚙' },
]

// "This project": which project the tab configures (defaults to the selected one).
const projId = ref<string | null>(null)
const projDd = ref(false)
const proj = computed(
  () => projects.items.find((p) => p.id === projId.value) ?? projects.items[0] ?? null,
)

/** Applies to the project's NEXT session: the SDK permission mode is fixed at spawn. */
async function saveSessionMode(mode: SessionMode): Promise<void> {
  const target = proj.value
  if (!target || target.defaultSessionMode === mode) return
  await projects.setSessionMode(target.id, mode)
}

onMounted(() => {
  void store.load()
  projId.value = projects.selectedProjectId
  void store.loadAvailableModels()
})

function save(patch: Partial<Settings>): void {
  void store.save(patch)
}

// Sandbox memory: edited locally, saved on Enter/blur — saving per keystroke
// would persist half-typed sizes like "1" on the way to "12g".
const sandboxMemVal = ref('')
watch(
  () => settings.value?.sandboxMemory,
  (v) => {
    sandboxMemVal.value = v ?? '6g'
  },
  { immediate: true },
)

function saveSandboxMemory(): void {
  const value = sandboxMemVal.value.trim()
  if (!value || value === settings.value?.sandboxMemory) return
  save({ sandboxMemory: value })
}

// Per-project model overrides ('global' follows the Models tab). Data-driven so
// the intelligent + worker pickers share one loop (mirrors MODEL_SECTIONS above).
type ProjModelField = 'projectModels' | 'projectWorkerModels'
const PROJ_MODEL_SECTIONS = [
  {
    field: 'projectModels',
    globalKey: 'intelligentModel',
    testid: 'proj-model',
    label: 'INTELLIGENT MODEL',
    desc: 'Overrides the global default for this project only — plans, answers, orchestrates broad work, and advises the worker.',
  },
  {
    field: 'projectWorkerModels',
    globalKey: 'workerModel',
    testid: 'proj-worker',
    label: 'WORKER MODEL',
    desc: 'Overrides the global worker for this project only — the cheaper model that runs Advisor-mode turns and Orchestrator worker subagents here.',
  },
] as const

/** This project's override for a section, or 'global' when unset. */
function projModelFor(field: ProjModelField): string {
  const id = proj.value?.id
  return (id && settings.value?.[field]?.[id]) || 'global'
}

function saveProjModelFor(field: ProjModelField, modelId: string): void {
  if (!proj.value || !settings.value) return
  const map = { ...settings.value[field], [proj.value.id]: modelId }
  save(field === 'projectModels' ? { projectModels: map } : { projectWorkerModels: map })
}

// Hoisted like TABS / MODE_CHOICES / MODEL_SECTIONS: an array literal written
// inline in a v-for is rebuilt on every render, and these never change.
const FONT_SIZES = [
  ['sm', 'Small'],
  ['md', 'Medium'],
  ['lg', 'Large'],
] as const satisfies readonly (readonly [Settings['fontSize'], string])[]

const TERSE_LEVELS = ['lite', 'full', 'ultra'] as const satisfies readonly TerseLevel[]

const terseExplain: Record<TerseLevel, string> = {
  lite: 'Light touch: drops filler and pleasantries, keeps full sentences.',
  full: 'Compact: fragments and bullets, conclusion first, no preamble.',
  ultra: 'Maximum: telegraphic notes only. Densest, least conversational.',
}

// Models this subscription can select, read from the CLI by the main process
// and owned by the settings store. The cards are built from that list alone —
// no hardcoded catalogue — so a model released today is selectable today, and a
// retired one stops being offered.
const availableModels = computed(() => store.availableModels)
const modelChoices = computed<ModelChoice[]>(() => [
  {
    id: 'default',
    label: modelLabel('default'),
    desc: 'Follows your subscription default model',
    price: '—',
  },
  ...availableModels.value.map((m) => ({
    id: m.id,
    label: modelLabel(m.id),
    desc: m.description,
    price: modelPrice(m.id),
  })),
])

// Advisor/Orchestrator pairing modes (see src/main/sessions/modes.ts).
const MODE_CHOICES: { id: Settings['modelMode']; label: string; desc: string }[] = [
  {
    id: 'auto',
    label: 'Auto (Recommended)',
    desc: 'Intelligent model runs the session; each message picks the pattern — scoped work consults the advisor, broad work delegates to workers.',
  },
  {
    id: 'advisor',
    label: 'Advisor',
    desc: 'Worker model runs the whole session and does the work; the intelligent model is a subagent consulted rarely for approach, unsticking, and review.',
  },
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    desc: 'Intelligent model runs the whole session, plans and reviews; well-scoped chunks go to cheap parallel workers.',
  },
]

// The Intelligent and Worker model pickers are the same card list bound to
// a different Settings field — render both from one loop.
const MODEL_SECTIONS = [
  {
    key: 'intelligentModel',
    testid: 'intelligent-model',
    label: 'INTELLIGENT MODEL',
    desc: 'The strong one: plans, answers questions, orchestrates broad work, and advises the worker.',
  },
  {
    key: 'workerModel',
    testid: 'worker-model',
    label: 'WORKER MODEL',
    desc: 'Always the cheaper one: executes Advisor-mode turns and runs Orchestrator worker subagents.',
  },
] as const

function setModel(key: 'intelligentModel' | 'workerModel', id: string): void {
  save(key === 'intelligentModel' ? { intelligentModel: id } : { workerModel: id })
}

// Allowed list tab (design): risk auto-approve + per-project command rules.
const { allowedRules, newCmd, setRuleMode, addAllowedCommand } = useAllowedRules({
  projectId: () => proj.value?.id,
  active: () => tab.value === 'allowed',
})

// --- Database MCP (General tab): designate which reported MCP server is the DB.
// Options are the union of MCP servers reported by any live session, plus the
// current designation so it stays visible even when no session reports it. ---
const dbMcpInput = ref('')
const mcpServerNames = computed(() => {
  const names = new Set<string>()
  for (const p of projects.items) {
    if (p.session && !p.session.endedAt) {
      for (const m of p.session.mcpServers ?? []) names.add(m.name)
    }
  }
  for (const n of settings.value?.databaseMcpServers ?? []) names.add(n)
  return [...names].sort()
})

function isDbMcp(name: string): boolean {
  return (settings.value?.databaseMcpServers ?? []).includes(name)
}

function toggleDatabaseMcp(name: string): void {
  if (!settings.value) return
  const current = settings.value.databaseMcpServers
  const activeNow = settings.value.mcpActiveServers
  const adding = !current.includes(name)
  const next = adding ? [...current, name] : current.filter((n) => n !== name)
  // A server added to the view defaults to active in the chat combination; a
  // removed one leaves the combination too (it is no longer tickable).
  const nextActive = adding
    ? [...new Set([...activeNow, name])]
    : activeNow.filter((n) => n !== name)
  // Apply locally first so a second quick click computes from this state, not
  // the pre-save snapshot (the save round-trip would otherwise drop a toggle).
  settings.value.databaseMcpServers = next
  settings.value.mcpActiveServers = nextActive
  save({ databaseMcpServers: next, mcpActiveServers: nextActive })
}

function addDatabaseMcp(): void {
  const name = dbMcpInput.value.trim()
  if (!name) return
  dbMcpInput.value = ''
  if (!isDbMcp(name)) toggleDatabaseMcp(name)
}

const mcpSelSummary = computed(() => {
  const n = (settings.value?.databaseMcpServers ?? []).length
  if (n === 0) return 'None selected — sessions still expose every server individually.'
  if (n === 1) return '1 server on the MCP view.'
  return `${n} servers on the MCP view — tick a combination there to chat.`
})

const updateLine = computed(() => {
  const s = updates.status
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Update ${s.version ?? ''} available — click Download to get the installer.`
    case 'downloading':
      return `Downloading update… ${s.percent ?? 0}%`
    case 'ready':
      return `Update ${s.version ?? ''} ready. Restart to apply.`
    case 'none':
      return 'You are on the latest version.'
    case 'error':
      // Not always a *check* failure — the message says what actually failed.
      return `Update problem: ${s.message ?? 'unknown error'}`
    default:
      return 'Updates are delivered from GitHub releases.'
  }
})
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div
      ref="dialog"
      class="dialog settings"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1" data-testid="settings-panel">
      <!-- Header -->
      <div class="s-head">
        <span class="gear mono">⚙</span>
        <span class="s-title mono">Settings</span>
        <span style="flex: 1"></span>
        <button class="s-x mono" data-testid="settings-close" @click="emit('close')">✕</button>
      </div>

      <div class="s-main">
        <!-- Left tab rail -->
        <div class="rail">
          <button
            v-for="t in TABS"
            :key="t.id"
            class="rail-tab"
            :class="{ sel: tab === t.id }"
            :data-testid="`settings-tab-${t.id}`"
            @click="tab = t.id"
          >
            <span class="rt-icon mono">{{ t.icon }}</span>
            <span class="rt-label mono">{{ t.label }}</span>
          </button>
          <span style="flex: 1"></span>
          <div v-if="settings" class="rail-foot mono">
            Smart {{ modelLabel(settings.intelligentModel) }}<br />Worker {{ modelLabel(settings.workerModel) }}
          </div>
        </div>

        <!-- Content pane -->
        <div v-if="settings" class="s-body">
          <!-- MODELS -->
          <template v-if="tab === 'models'">
            <div class="group">
              <div class="group-label mono">MODE</div>
              <div class="group-desc">
                How the strong and cheap models pair up on work. Auto picks per message from the
                workload; both patterns keep most tokens on the cheaper model.
              </div>
              <div class="cards">
                <button
                  v-for="m in MODE_CHOICES"
                  :key="m.id"
                  class="card-opt"
                  :class="{ sel: (settings?.modelMode ?? 'auto') === m.id }"
                  :data-testid="`mode-${m.id}`"
                  @click="save({ modelMode: m.id })"
                >
                  <span class="opt-dot" :class="{ on: (settings?.modelMode ?? 'auto') === m.id }"></span>
                  <div class="opt-body">
                    <div class="opt-name mono">{{ m.label }}</div>
                    <div class="opt-sub">{{ m.desc }}</div>
                  </div>
                </button>
              </div>
            </div>

            <div v-for="section in MODEL_SECTIONS" :key="section.key" class="group">
              <div class="group-label mono">{{ section.label }}</div>
              <div class="group-desc">{{ section.desc }}</div>
              <div class="cards">
                <button
                  v-for="m in modelChoices"
                  :key="m.id"
                  class="card-opt"
                  :class="{ sel: settings[section.key] === m.id }"
                  :data-testid="`${section.testid}-${m.id}`"
                  @click="setModel(section.key, m.id)"
                >
                  <span class="opt-dot" :class="{ on: settings[section.key] === m.id }"></span>
                  <div class="opt-body">
                    <div class="opt-name mono">{{ m.label }}</div>
                    <div class="opt-sub">{{ m.desc }}</div>
                  </div>
                  <span class="opt-price mono">{{ m.price }}</span>
                </button>
              </div>
            </div>

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Pair models by message</div>
                <div class="sr-desc">
                  Reads each message and picks the pattern for that turn — consult the advisor, or
                  delegate to workers. The session keeps ONE main model either way: switching it
                  mid-session would throw away the prompt cache and re-bill the whole conversation.
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.autoModelRouting }"
                data-testid="setting-auto-routing"
                role="switch"
                :aria-checked="settings.autoModelRouting"
                @click="save({ autoModelRouting: !settings.autoModelRouting })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="note">
              These apply to every project. New sessions pick them up immediately; running sessions
              switch on their next turn. Override per project in the "This project" tab.
            </div>
          </template>

          <!-- THIS PROJECT -->
          <template v-else-if="tab === 'proj'">
            <div v-if="!proj" class="note">No projects yet — add one from the sidebar first.</div>
            <template v-else>
              <div class="proj-card">
                <div class="group-label mono">PROJECT</div>
                <div class="dd-wrap">
                  <button class="dd" data-testid="proj-settings-picker" @click="projDd = !projDd">
                    <span class="dd-dot"></span>
                    <span class="dd-name mono">{{ proj.name }}</span>
                    <span class="dd-arrow mono">{{ projDd ? '▲' : '▼' }}</span>
                  </button>
                  <div v-if="projDd" class="dd-list">
                    <button
                      v-for="p in projects.items"
                      :key="p.id"
                      class="dd-item"
                      :class="{ sel: p.id === proj.id }"
                      :data-testid="`proj-settings-option-${p.id}`"
                      @click="((projId = p.id), (projDd = false))"
                    >
                      <span class="dd-check mono">{{ p.id === proj.id ? '✓' : '' }}</span>
                      <span class="mono">{{ p.name }}</span>
                    </button>
                  </div>
                </div>
                <div class="proj-note">
                  Everything below applies only to <span class="mono proj-name">{{ proj.name }}</span>
                </div>
              </div>

              <!-- The mode chosen when the project was added, changeable here. Same
                   card idiom as the model sections below rather than a second kind of
                   picker, so one project tab reads as one list of settings. -->
              <div class="group">
                <div class="group-label mono">SESSION TYPE</div>
                <div class="group-desc">
                  What this project's sessions may do without asking. Applies to the next session
                  it starts, not one already running.
                </div>
                <div class="cards" data-testid="proj-session-mode">
                  <button
                    v-for="m in SESSION_MODES"
                    :key="m.value"
                    class="card-opt"
                    :class="{ sel: proj.defaultSessionMode === m.value }"
                    :data-testid="`proj-session-mode-${m.value}`"
                    @click="saveSessionMode(m.value)"
                  >
                    <span class="opt-dot" :class="{ on: proj.defaultSessionMode === m.value }"></span>
                    <div class="opt-body">
                      <div class="opt-name mono">{{ m.label }}</div>
                      <div class="opt-sub">{{ m.detail }}</div>
                    </div>
                    <span class="opt-price mono">{{ m.value === 'bypass' ? '⚠' : '—' }}</span>
                  </button>
                </div>
              </div>

              <div v-for="section in PROJ_MODEL_SECTIONS" :key="section.field" class="group">
                <div class="group-label mono">{{ section.label }}</div>
                <div class="group-desc">{{ section.desc }}</div>
                <div class="cards">
                  <button
                    class="card-opt"
                    :class="{ sel: projModelFor(section.field) === 'global' }"
                    :data-testid="`${section.testid}-global`"
                    @click="saveProjModelFor(section.field, 'global')"
                  >
                    <span class="opt-dot" :class="{ on: projModelFor(section.field) === 'global' }"></span>
                    <div class="opt-body">
                      <div class="opt-name mono">Use global default</div>
                      <div class="opt-sub">Follows the Models tab ({{ modelLabel(settings[section.globalKey]) }})</div>
                    </div>
                    <span class="opt-price mono">—</span>
                  </button>
                  <button
                    v-for="m in modelChoices"
                    :key="m.id"
                    class="card-opt"
                    :class="{ sel: projModelFor(section.field) === m.id }"
                    :data-testid="`${section.testid}-${m.id}`"
                    @click="saveProjModelFor(section.field, m.id)"
                  >
                    <span class="opt-dot" :class="{ on: projModelFor(section.field) === m.id }"></span>
                    <div class="opt-body">
                      <div class="opt-name mono">{{ m.label }}</div>
                      <div class="opt-sub">{{ m.desc }}</div>
                    </div>
                    <span class="opt-price mono">{{ m.price }}</span>
                  </button>
                </div>
              </div>

            </template>
          </template>

          <!-- MCP -->
          <template v-else-if="tab === 'mcp'">
            <div class="group-label mono">MCP SERVERS</div>
            <div class="group-desc">
              Sessions expose every configured MCP server. Select the ones to combine into a single
              chat — they show in the sidebar MCP section and are used together in the schema scan
              and chat (e.g. a database plus a code-search server in one conversation).
            </div>
            <div class="cards" data-testid="db-mcp-options">
              <button
                v-for="name in mcpServerNames"
                :key="name"
                class="card-opt mcp-opt"
                :class="{ sel: isDbMcp(name) }"
                :data-testid="`db-mcp-${name}`"
                @click="toggleDatabaseMcp(name)"
              >
                <span class="mcp-check" :class="{ on: isDbMcp(name) }">{{ isDbMcp(name) ? '✓' : '' }}</span>
                <span class="mcp-ico">⛁</span>
                <div class="opt-body">
                  <div class="opt-name mono">{{ name }}</div>
                  <div class="opt-sub">
                    {{ isDbMcp(name) ? 'Shown in the MCP view' : 'Add to the MCP view' }}
                  </div>
                </div>
              </button>
            </div>
            <div v-if="mcpServerNames.length === 0" class="note">
              No MCP servers reported yet — start a session and its servers appear here to choose
              from. You can also type the exact server name below.
            </div>
            <div class="add-cmd">
              <span class="add-cmd-plus mono">＋</span>
              <input
                v-model="dbMcpInput"
                class="add-cmd-input mono"
                data-testid="db-mcp-input"
                placeholder="Or type the server name exactly — e.g. postgres"
                @keydown.enter="addDatabaseMcp"
              />
              <button class="add-cmd-btn mono" data-testid="db-mcp-set" @click="addDatabaseMcp">Add</button>
            </div>
            <div class="group-desc" style="margin-top: 12px">
              {{ mcpSelSummary }}
            </div>
          </template>

          <!-- ALLOWED LIST -->
          <template v-else-if="tab === 'allowed'">
            <div class="group-label mono">AUTO-APPROVE BY RISK</div>
            <div class="group-desc">
              Requests at these risk levels are approved automatically and land in history as
              rule-approved. High risk always asks.
            </div>
            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Low risk</div>
                <div class="sr-desc">Read-only inspection — file reads, git status, listings</div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.autoApproveLow }"
                data-testid="setting-auto-low"
                role="switch"
                :aria-checked="settings.autoApproveLow"
                @click="save({ autoApproveLow: !settings.autoApproveLow })"
              >
                <span class="knob"></span>
              </button>
            </div>
            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Medium risk</div>
                <div class="sr-desc">Routine changes — file edits, package installs, builds</div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.autoApproveMedium }"
                data-testid="setting-auto-medium"
                role="switch"
                :aria-checked="settings.autoApproveMedium"
                @click="save({ autoApproveMedium: !settings.autoApproveMedium })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="group-label mono" style="margin-top: 8px">ALLOWED COMMANDS</div>
            <div class="group-desc">
              Standing rules for
              <span class="mono proj-name">{{ proj?.name ?? 'this project' }}</span> — created from
              history (right-click a command) or added here. Auto approves without asking; Ask
              restores the inbox prompt.
            </div>
            <div class="cards" data-testid="allowed-rules">
              <div v-for="r in allowedRules" :key="r.id" class="card-opt static">
                <div class="opt-body">
                  <div class="opt-name mono">{{ r.matcher.value ?? r.toolName }}</div>
                  <div class="opt-sub">{{ MATCHER_KIND_LABEL[r.matcher.kind] }}</div>
                </div>
                <div class="seg mono">
                  <button
                    class="seg-opt"
                    :class="{ on: r.revokedAt !== null }"
                    :data-testid="`rule-ask-${r.id}`"
                    @click="setRuleMode(r, 'ask')"
                  >
                    Ask
                  </button>
                  <button
                    class="seg-opt seg-auto"
                    :class="{ on: r.revokedAt === null }"
                    :data-testid="`rule-auto-${r.id}`"
                    @click="setRuleMode(r, 'auto')"
                  >
                    Auto
                  </button>
                </div>
              </div>
              <div class="card-opt static">
                <div class="opt-body">
                  <div class="opt-name mono">rm · sudo · git push</div>
                  <div class="opt-sub">Destructive or irreversible — can never be auto-approved</div>
                </div>
                <span class="lock-chip mono">Always ask</span>
              </div>
            </div>
            <div class="add-cmd">
              <span class="add-cmd-plus mono">＋</span>
              <input
                v-model="newCmd"
                class="add-cmd-input mono"
                data-testid="allowed-add-input"
                placeholder="Add a command — e.g. make build"
                @keydown.enter="addAllowedCommand"
              />
              <button class="add-cmd-btn mono" data-testid="allowed-add-btn" @click="addAllowedCommand">
                Allow
              </button>
            </div>
          </template>

          <!-- TERMINALS -->
          <template v-else-if="tab === 'term'">
            <div class="group-label mono">OUTPUT</div>
            <div class="group-desc">How each session's output looks and behaves.</div>

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Font size</div>
                <div class="sr-desc">Text size in the Clean and Raw views</div>
              </div>
              <div class="seg mono">
                <button
                  v-for="[v, label] in FONT_SIZES"
                  :key="v"
                  class="seg-opt"
                  :class="{ on: settings.fontSize === v }"
                  :data-testid="`setting-font-${v}`"
                  @click="save({ fontSize: v })"
                >
                  {{ label }}
                </button>
              </div>
            </div>

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Default view</div>
                <div class="sr-desc">What a session opens in — Clean summaries or the raw terminal</div>
              </div>
              <div class="seg mono">
                <button
                  class="seg-opt"
                  :class="{ on: settings.defaultView === 'clean' }"
                  data-testid="setting-view-clean"
                  @click="save({ defaultView: 'clean' })"
                >
                  Clean
                </button>
                <button
                  class="seg-opt"
                  :class="{ on: settings.defaultView === 'raw' }"
                  data-testid="setting-view-raw"
                  @click="save({ defaultView: 'raw' })"
                >
                  Raw
                </button>
              </div>
            </div>

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Show tool activity in Clean view</div>
                <div class="sr-desc">
                  Off: Clean view hides commands and tool calls entirely. On: they collapse into
                  expandable "worked quietly" rows. Raw view always shows everything.
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.showToolRows }"
                data-testid="setting-tool-rows"
                role="switch"
                :aria-checked="settings.showToolRows"
                @click="save({ showToolRows: !settings.showToolRows })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Timestamps</div>
                <div class="sr-desc">Show the time next to every event in the Clean view</div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.timestamps }"
                data-testid="setting-timestamps"
                role="switch"
                :aria-checked="settings.timestamps"
                @click="save({ timestamps: !settings.timestamps })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Follow output</div>
                <div class="sr-desc">Keep the view pinned to the newest line while Claude works</div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.autoscroll }"
                data-testid="setting-autoscroll"
                role="switch"
                :aria-checked="settings.autoscroll"
                @click="save({ autoscroll: !settings.autoscroll })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Turn summaries</div>
                <div class="sr-desc">
                  Style each turn's closing message as a ✦ SUMMARY. Off shows it as the raw response —
                  e.g. the full <span class="mono">/usage</span> report instead of a summary. Display
                  only; no extra model call.
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

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Terse mode</div>
                <div class="sr-desc">
                  Compresses only Claude's replies to you (output tokens), saving cost and time. Your
                  prompts and the context Claude reads are unchanged; code, commands, and errors stay
                  exact.
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.terseMode }"
                data-testid="setting-terse-mode"
                role="switch"
                :aria-checked="settings.terseMode"
                @click="save({ terseMode: !settings.terseMode })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Heavy subagents</div>
                <div class="sr-desc">
                  Divide and conquer. Every session is told to split work into independent parts
                  and dispatch them to as many subagents as the work allows, in one batch, rather
                  than working through a list on one thread. Faster on anything that decomposes,
                  and cheaper when the workers run the cheap model. It also pins the session to the
                  Orchestrator protocol, because Advisor's own instruction is to do scoped work
                  yourself and the two cannot both be in force.
                  <strong class="sr-warn">
                    It is read when a session starts, so this applies from the next session, not to
                    one already running. A session shaped by it carries a ⑂ Fan-out pill in its
                    header.
                  </strong>
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.heavySubagents }"
                data-testid="setting-heavy-subagents"
                role="switch"
                :aria-checked="settings.heavySubagents"
                @click="save({ heavySubagents: !settings.heavySubagents })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div v-if="settings.terseMode" class="group">
              <div class="group-label mono">TERSE LEVEL</div>
              <div class="group-desc">How aggressively replies are compressed.</div>
              <div class="cards">
                <button
                  v-for="level in TERSE_LEVELS"
                  :key="level"
                  class="card-opt"
                  :class="{ sel: settings.terseLevel === level }"
                  :data-testid="`terse-level-${level}`"
                  @click="save({ terseLevel: level })"
                >
                  <span class="opt-dot" :class="{ on: settings.terseLevel === level }"></span>
                  <div class="opt-body">
                    <div class="opt-name mono">{{ level }}</div>
                    <div class="opt-sub">{{ terseExplain[level] }}</div>
                  </div>
                </button>
              </div>
            </div>

            <div class="group-label mono" style="margin-top: 8px">BYPASS SANDBOX</div>
            <div class="group-desc">
              Bypass sessions run in a Docker container capped at this much memory, so one
              hungry build stops alone instead of killing every session (exit 137). Any Docker
              size — <span class="mono">6g</span>, <span class="mono">12g</span> — or
              <span class="mono">0</span> for no cap. Applies from the next bypass session.
            </div>
            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Sandbox memory</div>
                <div class="sr-desc">
                  Raise it if bypass sessions die with exit 137 during builds or test runs
                </div>
              </div>
              <input
                v-model="sandboxMemVal"
                class="add-cmd-input mono sandbox-mem-input"
                data-testid="setting-sandbox-memory"
                spellcheck="false"
                @keydown.enter="saveSandboxMemory"
                @blur="saveSandboxMemory"
              />
            </div>
          </template>

          <!-- GENERAL -->
          <template v-else>
            <div class="group-label mono">NOTIFICATIONS</div>
            <div class="group-desc">How Switchboard gets your attention.</div>
            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Desktop notifications</div>
                <div class="sr-desc">
                  Pop a notification when a session needs an approval, hits an error, or finishes —
                  you can approve right from it.
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.notificationsEnabled }"
                data-testid="setting-notifications"
                role="switch"
                :aria-checked="settings.notificationsEnabled"
                @click="save({ notificationsEnabled: !settings.notificationsEnabled })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="group-label mono" style="margin-top: 8px">APP UPDATES</div>
            <div class="group-desc">
              New versions are published to GitHub releases. Switchboard checks for a newer release
              and, when one exists, opens its download page so you can run the installer.
            </div>
            <div class="update-status mono" data-testid="update-status">{{ updateLine }}</div>
            <div class="update-actions">
              <button
                class="btn-quiet"
                data-testid="update-check"
                :disabled="updates.busy"
                @click="updates.check()"
              >
                Check for updates
              </button>
              <button
                v-if="updates.available"
                class="btn-solid"
                data-testid="update-install"
                @click="updates.install()"
              >
                Download update
              </button>
            </div>

            <div class="note" style="margin-top: 8px">
              Raw output is kept for the current and previous session per project; decision history
              for 30 days. All data stays on this machine.
            </div>
          </template>
        </div>
      </div>

      <!-- Footer -->
      <div class="s-foot mono">
        <span>Changes apply immediately</span>
        <span style="flex: 1"></span>
        <button class="btn-solid" data-testid="settings-done" @click="emit('close')">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  /* Local aliases for design rgba steps with no shared app token (rule 5) —
     themed for light via the html.sb-light override below. Dialog/dropdown
     shadows come from the shared --shadow-dlg/--shadow-dd tokens. */
  --hi09: rgba(255, 255, 255, 0.09);
  --hi22: rgba(255, 255, 255, 0.22);
  width: 730px;
  max-width: 94vw;
  height: 580px;
  max-height: 88vh;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-dlg);
}

html.sb-light .settings {
  --hi09: color-mix(in srgb, var(--detail) 9%, transparent);
  --hi22: color-mix(in srgb, var(--detail) 22%, transparent);
}

/* This dialog's own overlay tint/blur (design: separate from other dialogs') —
   scoped so it only touches the overlay this component renders. */
.overlay {
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

/* On paper this was 62% graphite: a near-blackout under one dialogue while every
   other dialogue in the theme used the pale --scrim, so light mode dimmed two
   different ways depending on which control you opened. --scrim is now itself a
   graphite veil, so this tier can just use it. */
html.sb-light .overlay {
  background: var(--scrim);
}

.s-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.gear {
  font-size: var(--fs-body);
  color: var(--text-meta);
}

.s-title {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-bright);
}

.s-x {
  font-size: var(--fs-body);
  color: var(--text-tab);
  padding: 2px 8px;
  border-radius: var(--rc);
  background: transparent;
}

.s-x:hover {
  color: var(--text-strong);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.s-main {
  display: flex;
  flex: 1;
  min-height: 0;
}

.rail {
  width: 168px;
  min-width: 168px;
  border-right: 1px solid var(--border);
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--bg-code);
}

.rail-tab {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-radius: var(--rc);
  border: 1px solid transparent;
  cursor: pointer;
  background: transparent;
  text-align: left;
}

.rail-tab:hover {
  background: var(--bg-hover);
  box-shadow: var(--elev);
}

.rail-tab.sel {
  background: var(--bg-active);
  border-color: var(--border-strong);
}

.rt-icon {
  font-size: var(--fs-meta);
  color: var(--text-faint);
  width: 13px;
}

.rail-tab.sel .rt-icon {
  color: var(--green);
}

.rt-label {
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.rail-tab.sel .rt-label {
  color: var(--text-strong);
}

.rail-foot {
  padding: 9px 11px;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--text-ghost);
}

.s-body {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.group {
  margin-bottom: 20px;
}

.group-label {
  font-size: var(--fs-micro);
  letter-spacing: 0.15em;
  color: var(--text-faint);
  margin-bottom: 4px;
}

.group-desc {
  font-size: var(--fs-ui);
  color: var(--text-meta);
  margin-bottom: 10px;
  text-wrap: pretty;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.card-opt {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 13px;
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--hi09);
  border-radius: var(--rc);
  cursor: pointer;
  text-align: left;
}

.card-opt:hover:not(.static) {
  border-color: var(--hi22);
}

.card-opt.sel {
  background: color-mix(in srgb, var(--green) 6%, transparent);
  border-color: color-mix(in srgb, var(--green) 40%, transparent);
}

.card-opt.static {
  cursor: default;
}

.card-opt.static .opt-name {
  font-size: var(--fs-body);
  color: var(--text-title);
}

.card-opt:not(.sel) .opt-sub {
  color: var(--text-tab);
}

.opt-dot {
  width: 8px;
  min-width: 8px;
  height: 8px;
  border-radius: var(--rp);
  border: 1.5px solid var(--hi22);
}

.opt-dot.on {
  background: var(--green);
  border-color: var(--green);
}

.opt-body {
  flex: 1;
  min-width: 0;
}

.opt-name {
  font-size: var(--fs-ui);
  font-weight: 600;
  color: var(--text-body);
}

.card-opt.sel .opt-name {
  color: var(--text-strong);
}

.opt-sub {
  font-size: var(--fs-meta);
  color: var(--text-meta);
  margin-top: 2px;
}

.opt-price {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  flex-shrink: 0;
}

/* MCP tab: a checkbox + database icon before the server name (design). */
.mcp-check {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  /* A fold is a cut: corners are square. The comment that used to sit here
     called 3px "the documented content radius", which was never true — the
     content radius is --rc, and it is 0. Both this and EvalsView's callout were
     leftovers from the replaced world's softer corners, missed when the token
     changed (DESIGN.md, Shapes: "drift to fix, not a third named exception"). */
  border-radius: var(--rc);
  border: 1.5px solid var(--border-strong);
  color: var(--green-ink);
  font-size: var(--fs-meta);
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mcp-check.on {
  border-color: var(--green);
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
}

.mcp-ico {
  flex-shrink: 0;
  font-size: var(--fs-head);
  color: var(--teal);
}

.mcp-opt {
  padding: 11px 13px;
  gap: 12px;
}

.lock-chip {
  font-size: var(--fs-micro);
  color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
  border-radius: var(--rc);
  padding: 2px 9px;
  white-space: nowrap;
  flex-shrink: 0;
}

.add-cmd {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 10px 13px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
}

.add-cmd-plus {
  flex-shrink: 0;
  color: var(--green);
}

.add-cmd-input {
  flex: 1;
  min-width: 60px;
  font-size: var(--fs-ui);
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-name);
  outline: none;
}

/* The sandbox memory field: a short boxed input on the setting row's right,
   where the other rows put their toggle or segmented control. */
.sandbox-mem-input {
  flex: 0 0 72px;
  text-align: right;
  padding: 5px 9px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--rc);
}

.add-cmd-btn {
  flex-shrink: 0;
  color: var(--text-mid);
  border: 1px solid var(--border-strong);
  font-size: var(--fs-meta);
  padding: 5px 12px;
  border-radius: var(--rc);
  cursor: pointer;
  background: transparent;
}

.add-cmd-btn:hover {
  border-color: var(--green);
  color: var(--text-strong);
}

.proj-card {
  padding: 11px 12px;
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--green) 18%, transparent);
  border-radius: var(--rc);
  margin-bottom: 10px;
}

.dd-wrap {
  position: relative;
}

.dd {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 13px;
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  cursor: pointer;
  text-align: left;
}

.dd:hover {
  border-color: var(--hi22);
}

.dd-dot {
  width: 8px;
  min-width: 8px;
  height: 8px;
  border-radius: var(--rp);
  background: var(--green);
}

.dd-name {
  flex: 1;
  font-size: var(--fs-ui);
  font-weight: 600;
  color: var(--text-strong);
}

.dd-arrow {
  font-size: var(--fs-micro);
  color: var(--text-tab);
}

.dd-list {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  right: 0;
  background: var(--bg-hover);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  overflow: hidden;
  z-index: 10;
  box-shadow: var(--shadow-dd);
  animation: sbIn 0.15s ease;
}

.dd-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 13px;
  cursor: pointer;
  font-size: var(--fs-ui);
  color: var(--text-mid);
  background: transparent;
  text-align: left;
}

.dd-item:hover {
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.dd-item.sel {
  background: color-mix(in srgb, var(--green) 7%, transparent);
  color: var(--text-strong);
}

.dd-check {
  width: 12px;
  min-width: 12px;
  font-size: var(--fs-meta);
  color: var(--green);
}

.proj-note {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  margin-top: 8px;
}

.proj-name {
  color: var(--text-body);
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 13px;
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--hi09);
  border-radius: var(--rc);
}

.sr-text {
  flex: 1;
  min-width: 0;
}

.sr-label {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-title);
}

.sr-desc {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  margin-top: 2px;
  line-height: 1.5;
  text-wrap: pretty;
}

/* When a setting does not take effect where the developer just flipped it, that
   sentence is the whole point of the paragraph. Its own line, brighter, not bold
   prose buried mid-description. */
.sr-warn {
  display: block;
  margin-top: 5px;
  font-weight: 400;
  color: var(--text-body);
}

.seg {
  display: flex;
  flex-shrink: 0;
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  overflow: hidden;
}

.seg-opt {
  padding: 5px 12px;
  font-size: var(--fs-meta);
  color: var(--text-tab);
  cursor: pointer;
  background: transparent;
}

.seg-opt:hover {
  color: var(--text-body);
}

.seg-opt.on {
  background: color-mix(in srgb, var(--green) 24%, transparent);
  color: var(--text-strong);
}

/* Allowed-list rows (design): the Auto pill, once active, gets its own
   lower-emphasis green treatment distinct from the generic seg selection. */
.seg-auto.on {
  background: color-mix(in srgb, var(--green) 15%, transparent);
  color: var(--green);
}

.note {
  padding: 10px 13px;
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--green) 18%, transparent);
  border-radius: var(--rc);
  font-size: var(--fs-meta);
  line-height: 1.55;
  color: var(--text-meta);
}

.update-status {
  font-size: var(--fs-ui);
  color: var(--text-body);
  padding: 10px 13px;
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--green) 18%, transparent);
  border-radius: var(--rc);
  margin-bottom: 12px;
}

.update-actions {
  display: flex;
  gap: 8px;
}

.s-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

/* Design's toggle track/knob are rounded rects (var(--rc)), not a pill — scoped
   here so it only reshapes the switches this dialog renders. */
.switch {
  border-radius: var(--rc);
}

.switch .knob {
  border-radius: var(--rc);
}
</style>
