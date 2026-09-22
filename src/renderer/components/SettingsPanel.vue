<script setup lang="ts">
import { useTemplateRef, computed, nextTick, onMounted, ref, watch } from 'vue'
import { useModal } from '@renderer/composables/useModal'
import { MATCHER_KIND_LABEL, useAllowedRules } from '@renderer/composables/useAllowedRules'
import type {
  CustomSkill,
  ModelChoice,
  SessionEngine,
  SessionMode,
  Settings,
} from '@shared/domain'
import { engineOf, modelLabel, modelPrice, SESSION_MODES } from '@shared/domain'
import { readSkillSource, skillSourceLabel } from '@shared/skill-source'
import { useSettingsStore } from '@renderer/stores/settings'
import { useProjectsStore } from '@renderer/stores/projects'
import { useUpdatesStore } from '@renderer/stores/updates'
import { useSkillsStore } from '@renderer/stores/skills'
import Icon from '@renderer/components/Icon.vue'
import EffortBar from '@renderer/components/EffortBar.vue'

const props = defineProps<{ initialTab?: 'models' | 'proj' | 'allowed' | 'skills' | 'term' | 'gen' }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = useTemplateRef<HTMLElement>('dialog')
useModal(dialogEl, () => emit('close'))
const store = useSettingsStore()
const skills = useSkillsStore()

const skillUrl = ref('')

const skillSource = computed(() => (skillUrl.value.trim() === '' ? null : readSkillSource(skillUrl.value)))

const skillSourceParts = computed(() => {
  const parsed = skillSource.value
  if (!parsed?.ok) return null
  const { owner, repo, ref: gitRef, path } = parsed.source
  return [
    { label: 'repository', value: `${owner}/${repo}` },
    { label: 'branch', value: gitRef ?? 'default branch' },
    { label: 'folder', value: path === '' ? 'whole repository' : path },
  ]
})

async function importSkills(): Promise<void> {
  const url = skillUrl.value.trim()
  if (!url || skills.importing || skillSource.value?.ok !== true) return
  if (await skills.import(url)) skillUrl.value = ''
}

const skillsBySource = computed<{ url: string; label: string; items: CustomSkill[] }[]>(() => {
  const groups = new Map<string, CustomSkill[]>()
  for (const skill of skills.items) {
    const list = groups.get(skill.sourceUrl)
    if (list) list.push(skill)
    else groups.set(skill.sourceUrl, [skill])
  }
  return [...groups].map(([url, items]) => {
    const parsed = readSkillSource(url)
    return { url, label: parsed.ok ? skillSourceLabel(parsed.source) : url, items }
  })
})

async function setGroupEnabled(items: CustomSkill[], on: boolean): Promise<void> {
  for (const skill of items) {
    if (skill.enabled !== on) await skills.setEnabled(skill.name, on)
  }
}
const projects = useProjectsStore()
const updates = useUpdatesStore()
const settings = computed(() => store.settings)

type Tab = 'models' | 'proj' | 'mcp' | 'allowed' | 'skills' | 'term' | 'gen'
const tab = ref<Tab>(props.initialTab ?? 'models')
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'models', label: 'Models', icon: 'spark' },
  { id: 'proj', label: 'This project', icon: 'folder' },
  { id: 'mcp', label: 'MCP', icon: 'database' },
  { id: 'allowed', label: 'Allowed list', icon: 'square-check' },
  { id: 'skills', label: 'Skills', icon: 'spark' },
  { id: 'term', label: 'Terminals', icon: 'terminal' },
  { id: 'gen', label: 'General', icon: 'settings' },
]

const projId = ref<string | null>(null)
const projDd = ref(false)
const projFilter = ref('')
const projActive = ref(0)
const projFilterEl = useTemplateRef<HTMLInputElement>('projFilterEl')

const projMatches = computed(() => {
  const q = projFilter.value.trim().toLowerCase()
  const all = projects.items.filter((p) => !p.reserved)
  return q === '' ? all : all.filter((p) => p.name.toLowerCase().includes(q))
})

function openProjDd(): void {
  projDd.value = !projDd.value
  if (!projDd.value) return
  projFilter.value = ''
  projActive.value = Math.max(
    0,
    projMatches.value.findIndex((p) => p.id === proj.value?.id),
  )
  void nextTick(() => projFilterEl.value?.focus())
}

function chooseProj(id: string): void {
  projId.value = id
  projDd.value = false
}

function onProjKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    projDd.value = false
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    projActive.value = Math.min(
      Math.max(projActive.value + step, 0),
      Math.max(projMatches.value.length - 1, 0),
    )
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const pick = projMatches.value[projActive.value]
    if (pick) chooseProj(pick.id)
  }
}

watch(projMatches, () => {
  projActive.value = 0
})
const proj = computed(
  () => projects.items.find((p) => p.id === projId.value) ?? projects.items[0] ?? null,
)

async function saveSessionMode(mode: SessionMode): Promise<void> {
  const target = proj.value
  if (!target || target.defaultSessionMode === mode) return
  await projects.setSessionMode(target.id, mode)
}

onMounted(() => {
  void store.load()
  projId.value = projects.selectedProjectId
  void store.loadAvailableModels()
  void skills.load()
})

function save(patch: Partial<Settings>): void {
  void store.save(patch)
}

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

const FONT_SIZES = [
  ['sm', 'Small'],
  ['md', 'Medium'],
  ['lg', 'Large'],
] as const satisfies readonly (readonly [Settings['fontSize'], string])[]

const availableModels = computed(() => store.availableModels)
const claudeModels = computed(() => availableModels.value.filter((m) => engineOf(m) === 'claude'))
const codexModels = computed(() => availableModels.value.filter((m) => engineOf(m) === 'codex'))
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
    desc: 'The full app: permission inbox, plan mode, WSL containers, advisor/worker pairing.',
  },
  {
    id: 'codex',
    label: 'Codex',
    desc: 'The OpenAI Codex CLI. One model, its own sandbox, and no approval prompts routed here.',
  },
]

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
  {
    id: 'basic',
    label: 'Basic (cheapest)',
    desc: 'Worker model alone. No advisor, no workers, no delegation protocol — one model answering directly. Turns heavy subagents and per-message routing off for the session, whatever they are set to.',
  },
]

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

const { allowedRules, newCmd, setRuleMode, addAllowedCommand } = useAllowedRules({
  projectId: () => proj.value?.id,
  active: () => tab.value === 'allowed',
})

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
  const nextActive = adding
    ? [...new Set([...activeNow, name])]
    : activeNow.filter((n) => n !== name)
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
      <div class="s-head">
        <Icon name="settings" class="gear" />
        <span class="s-title">Settings</span>
        <span class="spacer"></span>
        <button
          class="s-x"
          data-testid="settings-close"
          aria-label="Close settings"
          @click="emit('close')"
        >
          <Icon name="close" />
        </button>
      </div>

      <div class="s-main">
        <div class="rail">
          <button
            v-for="t in TABS"
            :key="t.id"
            class="rail-tab"
            :class="{ sel: tab === t.id }"
            :data-testid="`settings-tab-${t.id}`"
            @click="tab = t.id"
          >
            <Icon :name="t.icon" class="rt-icon" />
            <span class="rt-label">{{ t.label }}</span>
          </button>
          <span class="spacer"></span>
          <div v-if="settings" class="rail-foot mono">
            Smart {{ modelLabel(settings.intelligentModel) }}<br />Worker {{ modelLabel(settings.workerModel) }}
          </div>
        </div>

        <div v-if="settings" class="s-body">
          <template v-if="tab === 'models'">
            <div class="group">
              <div class="ui-kicker group-label">MODE</div>
              <div class="group-desc">
                How the strong and cheap models pair up on work. Auto picks per message from the
                workload; both patterns keep most tokens on the cheaper model.
              </div>
              <div class="cards">
                <button
                  v-for="m in MODE_CHOICES"
                  :key="m.id"
                  class="ui-card card-opt is-actionable"
                  :class="{ sel: (settings?.modelMode ?? 'auto') === m.id, 'is-selected': (settings?.modelMode ?? 'auto') === m.id }"
                  :data-testid="`mode-${m.id}`"
                  @click="save({ modelMode: m.id })"
                >
                  <span class="opt-dot" :class="{ on: (settings?.modelMode ?? 'auto') === m.id }"></span>
                  <div class="opt-body">
                    <div class="opt-name">{{ m.label }}</div>
                    <div class="opt-sub">{{ m.desc }}</div>
                  </div>
                </button>
              </div>
            </div>

            <div v-for="section in MODEL_SECTIONS" :key="section.key" class="group">
              <div class="ui-kicker group-label">{{ section.label }}</div>
              <div class="group-desc">{{ section.desc }}</div>
              <div class="cards">
                <button
                  v-for="m in modelChoices"
                  :key="m.id"
                  class="ui-card card-opt is-actionable"
                  :class="{ sel: settings[section.key] === m.id, 'is-selected': settings[section.key] === m.id }"
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

            <div class="group">
              <div class="ui-kicker group-label">ENGINE FOR NEW SESSIONS</div>
              <div class="group-desc">
                Which CLI a new session starts on. A Codex session has no permission inbox, no plan
                mode and no container: Codex decides inside its own sandbox, and the session's mode
                chooses which sandbox. Either engine can be picked per session when starting one.
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
              <div class="ui-kicker group-label">CODEX MODEL</div>
              <div class="group-desc">
                The model Codex sessions run, read from the Codex CLI itself.
                <template v-if="codexModels.length === 0">
                  No models listed — the Codex CLI was not found, or it did not answer. Install it
                  with <span class="mono">npm i -g @openai/codex</span> and sign in with
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

            <div class="ui-card setting-row is-actionable">
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

            <div class="ui-card">
              These apply to every project. New sessions pick them up immediately; running sessions
              switch on their next turn. Override per project in the "This project" tab.
            </div>
          </template>

          <template v-else-if="tab === 'proj'">
            <div v-if="!proj" class="ui-card">No projects yet — add one from the sidebar first.</div>
            <template v-else>
              <div class="ui-card proj-card">
                <div class="ui-kicker group-label">PROJECT</div>
                <div class="dd-wrap">
                  <button
                    class="dd"
                    :class="{ open: projDd }"
                    data-testid="proj-settings-picker"
                    :aria-expanded="projDd"
                    aria-haspopup="listbox"
                    @click="openProjDd"
                  >
                    <span class="dd-dot"></span>
                    <span class="dd-name">{{ proj.name }}</span>
                    <Icon name="chevron-down" class="dd-arrow" :class="{ open: projDd }" :size="11" />
                  </button>
                  <div v-if="projDd" class="suggest-list dd-list">
                    <input
                      ref="projFilterEl"
                      v-model="projFilter"
                      class="dd-search"
                      data-testid="proj-settings-search"
                      placeholder="Filter projects…"
                      role="combobox"
                      aria-controls="proj-dd-list"
                      :aria-expanded="projDd"
                      :aria-activedescendant="
                        projMatches[projActive] ? `proj-dd-${projMatches[projActive].id}` : undefined
                      "
                      @keydown="onProjKeydown"
                    />
                    <div id="proj-dd-list" class="dd-scroll" role="listbox" aria-label="Projects">
                      <button
                        v-for="(p, i) in projMatches"
                        :id="`proj-dd-${p.id}`"
                        :key="p.id"
                        class="suggest-item dd-item"
                        :class="{ sel: p.id === proj.id, active: i === projActive }"
                        role="option"
                        :aria-selected="p.id === proj.id"
                        :data-testid="`proj-settings-option-${p.id}`"
                        @click="chooseProj(p.id)"
                        @mouseenter="projActive = i"
                      >
                        <span class="dd-check">
                          <Icon v-if="p.id === proj.id" name="check" :size="11" />
                        </span>
                        <span>{{ p.name }}</span>
                      </button>
                      <div
                        v-if="projMatches.length === 0"
                        class="dd-empty"
                        data-testid="proj-settings-empty"
                      >
                        No project matches “{{ projFilter }}”.
                      </div>
                    </div>
                  </div>
                </div>
                <div class="proj-note">
                  Everything below applies only to <span class="proj-name">{{ proj.name }}</span>
                </div>
              </div>

              <div class="group">
                <div class="ui-kicker group-label">SESSION TYPE</div>
                <div class="group-desc">
                  What this project's sessions may do without asking. Applies to the next session
                  it starts, not one already running.
                </div>
                <div class="cards" data-testid="proj-session-mode">
                  <button
                    v-for="m in SESSION_MODES"
                    :key="m.value"
                    class="ui-card card-opt is-actionable"
                    :class="{ sel: proj.defaultSessionMode === m.value, 'is-selected': proj.defaultSessionMode === m.value }"
                    :data-testid="`proj-session-mode-${m.value}`"
                    @click="saveSessionMode(m.value)"
                  >
                    <span class="opt-dot" :class="{ on: proj.defaultSessionMode === m.value }"></span>
                    <div class="opt-body">
                      <div class="opt-name">{{ m.label }}</div>
                      <div class="opt-sub">{{ m.detail }}</div>
                    </div>
                    <span class="opt-price mono">
                      <Icon v-if="m.value === 'bypass'" name="warning" :size="12" />
                      <template v-else>—</template>
                    </span>
                  </button>
                </div>
              </div>

            </template>
          </template>

          <template v-else-if="tab === 'mcp'">
            <div class="ui-kicker group-label">MCP SERVERS</div>
            <div class="group-desc">
              Sessions expose every configured MCP server. Select the ones to combine into a single
              chat — they show in the sidebar MCP section and are used together in the schema scan
              and chat (e.g. a database plus a code-search server in one conversation).
            </div>
            <div class="cards" data-testid="db-mcp-options">
              <button
                v-for="name in mcpServerNames"
                :key="name"
                class="ui-card card-opt mcp-opt is-actionable"
                :class="{ sel: isDbMcp(name), 'is-selected': isDbMcp(name) }"
                :data-testid="`db-mcp-${name}`"
                @click="toggleDatabaseMcp(name)"
              >
                <span class="mcp-check" :class="{ on: isDbMcp(name) }">
                  <Icon v-if="isDbMcp(name)" name="check" :size="12" />
                </span>
                <Icon name="database" class="mcp-ico" :size="18" />
                <div class="opt-body">
                  <div class="opt-name mono">{{ name }}</div>
                  <div class="opt-sub">
                    {{ isDbMcp(name) ? 'Shown in the MCP view' : 'Add to the MCP view' }}
                  </div>
                </div>
              </button>
            </div>
            <div v-if="mcpServerNames.length === 0" class="ui-card">
              No MCP servers reported yet — start a session and its servers appear here to choose
              from. You can also type the exact server name below.
            </div>
            <div class="add-cmd">
              <Icon name="plus" class="add-cmd-plus" />
              <input
                v-model="dbMcpInput"
                class="add-cmd-input mono"
                data-testid="db-mcp-input"
                placeholder="Or type the server name exactly — e.g. postgres"
                @keydown.enter="addDatabaseMcp"
              />
              <button class="btn-quiet" data-testid="db-mcp-set" @click="addDatabaseMcp">Add</button>
            </div>
            <div class="group-desc" style="margin-top: 12px">
              {{ mcpSelSummary }}
            </div>
          </template>

          <template v-else-if="tab === 'allowed'">
            <div class="ui-kicker group-label">AUTO-APPROVE BY RISK</div>
            <div class="group-desc">
              Requests at these risk levels are approved automatically and land in history as
              rule-approved. High risk always asks.
            </div>
            <div class="ui-card setting-row is-actionable">
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
            <div class="ui-card setting-row is-actionable">
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

            <div class="ui-kicker group-label" style="margin-top: 8px">ALLOWED COMMANDS</div>
            <div class="group-desc">
              Standing rules for
              <span class="proj-name">{{ proj?.name ?? 'this project' }}</span> — created from
              history (right-click a command) or added here. Auto approves without asking; Ask
              restores the inbox prompt.
            </div>
            <div class="cards" data-testid="allowed-rules">
              <div v-for="r in allowedRules" :key="r.id" class="ui-card card-opt static">
                <div class="opt-body">
                  <div class="opt-name mono">{{ r.matcher.value ?? r.toolName }}</div>
                  <div class="opt-sub">{{ MATCHER_KIND_LABEL[r.matcher.kind] }}</div>
                </div>
                <div class="ui-segments">
                  <button
                    class="ui-seg"
                    :class="{ on: r.revokedAt !== null, 'is-on': r.revokedAt !== null }"
                    :data-testid="`rule-ask-${r.id}`"
                    @click="setRuleMode(r, 'ask')"
                  >
                    Ask
                  </button>
                  <button
                    class="ui-seg seg-auto"
                    :class="{ on: r.revokedAt === null, 'is-on': r.revokedAt === null }"
                    :data-testid="`rule-auto-${r.id}`"
                    @click="setRuleMode(r, 'auto')"
                  >
                    Auto
                  </button>
                </div>
              </div>
              <div class="ui-card card-opt static">
                <div class="opt-body">
                  <div class="opt-name mono">rm · sudo · git push</div>
                  <div class="opt-sub">Destructive or irreversible — can never be auto-approved</div>
                </div>
                <span class="chip-risk high">Always ask</span>
              </div>
            </div>
            <div class="add-cmd">
              <Icon name="plus" class="add-cmd-plus" />
              <input
                v-model="newCmd"
                class="add-cmd-input mono"
                data-testid="allowed-add-input"
                placeholder="Add a command — e.g. make build"
                @keydown.enter="addAllowedCommand"
              />
              <button class="btn-quiet" data-testid="allowed-add-btn" @click="addAllowedCommand">
                Allow
              </button>
            </div>
          </template>

          <template v-else-if="tab === 'skills'">
            <div class="ui-kicker group-label">IMPORT FROM GITHUB</div>
            <div class="group-desc">
              Paste a repository, or a folder inside one, and every skill under it is imported.
              Skills are user-level: switching one on makes it available to every project and
              every session, in the Skills tab and to the conversation alike.
            </div>

            <div class="add-cmd-row">
              <input
                v-model="skillUrl"
                class="add-cmd-input mono"
                :class="{ bad: skillSource?.ok === false }"
                data-testid="skills-url-input"
                placeholder="https://github.com/owner/repo/tree/main/skills"
                :disabled="skills.importing"
                :aria-invalid="skillSource?.ok === false ? 'true' : 'false'"
                :aria-describedby="skillSource ? 'skills-url-reading' : undefined"
                @keydown.enter="importSkills"
              />
              <button
                class="btn-quiet"
                data-testid="skills-import-btn"
                :disabled="skills.importing || skillSource?.ok !== true"
                @click="importSkills"
              >
                {{ skills.importing ? 'Importing…' : 'Import' }}
              </button>
            </div>

            <div v-if="skillSource" id="skills-url-reading" class="skill-reading" aria-live="polite">
              <div
                v-if="skillSourceParts"
                class="skill-reading-parts"
                data-testid="skills-url-reading"
              >
                <span v-for="part in skillSourceParts" :key="part.label" class="skill-part">
                  <span class="skill-part-label mono">{{ part.label }}</span>
                  <span class="skill-part-value mono">{{ part.value }}</span>
                </span>
              </div>
              <div v-else class="skill-reading-bad" data-testid="skills-url-problem">
                <Icon name="warning" :size="11" />
                {{ skillSource.ok === false ? skillSource.message : '' }}
              </div>
            </div>

            <div class="group-desc skills-caution">
              <Icon name="warning" :size="11" /> A skill is a set of instructions a session will
              follow. Import from repositories you trust, and read a skill before switching it on.
            </div>

            <div v-if="skills.error" class="skills-err" data-testid="skills-settings-error">
              {{ skills.error }}
            </div>
            <div
              v-if="skills.lastImport && skills.lastImport.skipped.length > 0"
              class="skills-skipped"
              data-testid="skills-skipped"
            >
              <div class="skipped-head mono">
                Skipped {{ skills.lastImport.skipped.length }} of
                {{ skills.lastImport.skipped.length + skills.lastImport.imported.length }}
              </div>
              <div v-for="s in skills.lastImport.skipped" :key="s.name" class="skipped-one">
                <span class="skipped-name mono">{{ s.name }}</span>
                <span class="skipped-why">{{ s.reason }}</span>
              </div>
            </div>

            <div class="ui-kicker group-label" style="margin-top: 12px">IMPORTED SKILLS</div>
            <div v-if="skills.items.length === 0" class="group-desc" data-testid="skills-none">
              None yet.
            </div>

            <div
              v-for="group in skillsBySource"
              :key="group.url"
              class="skill-group"
              :data-testid="`skill-group-${group.label}`"
            >
              <div class="skill-group-head">
                <span class="skill-group-name mono">{{ group.label }}</span>
                <span class="skill-group-count mono">
                  {{ group.items.filter((s) => s.enabled).length }}/{{ group.items.length }} on
                </span>
                <button
                  v-if="group.items.length > 1"
                  class="skill-group-all"
                  :data-testid="`skill-group-all-${group.label}`"
                  :title="`Switch every skill from ${group.label} on or off`"
                  @click="setGroupEnabled(group.items, !group.items.every((s) => s.enabled))"
                >
                  {{ group.items.every((s) => s.enabled) ? 'all off' : 'all on' }}
                </button>
              </div>

              <div
                v-for="skill in group.items"
                :key="skill.name"
                class="ui-card setting-row is-actionable"
                :data-testid="`skill-row-${skill.name}`"
              >
                <div class="sr-text">
                  <div class="sr-label mono">/{{ skill.name }}</div>
                  <div class="sr-desc">
                    {{ skill.description || 'No description in its SKILL.md.' }}
                  </div>
                  <div class="sr-desc skills-origin mono">
                    {{ skill.sourcePath || 'repository root' }} · {{ skill.fileCount }} file{{
                      skill.fileCount === 1 ? '' : 's'
                    }}
                  </div>
                </div>
                <div class="skills-actions">
                  <button
                    class="switch"
                    :class="{ on: skill.enabled }"
                    role="switch"
                    :aria-checked="skill.enabled"
                    :data-testid="`skill-toggle-${skill.name}`"
                    :title="
                      skill.enabled
                        ? 'On: every session can use this skill. Turning it off removes it from ~/.claude/skills.'
                        : 'Off: no session can see this skill. Turning it on copies it into ~/.claude/skills.'
                    "
                    @click="skills.setEnabled(skill.name, !skill.enabled)"
                  >
                    <span class="knob"></span>
                  </button>
                  <button
                    class="skills-remove"
                    :data-testid="`skill-remove-${skill.name}`"
                    title="Remove this skill and delete its files"
                    @click="skills.remove(skill.name)"
                  >
                    <Icon name="trash" :size="12" />
                  </button>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="tab === 'term'">
            <div class="ui-kicker group-label">OUTPUT</div>
            <div class="group-desc">How each session's output looks and behaves.</div>

            <div class="ui-card setting-row is-actionable">
              <div class="sr-text">
                <div class="sr-label">Font size</div>
                <div class="sr-desc">Text size in the Clean and Raw views</div>
              </div>
              <div class="ui-segments">
                <button
                  v-for="[v, label] in FONT_SIZES"
                  :key="v"
                  class="ui-seg"
                  :class="{ on: settings.fontSize === v, 'is-on': settings.fontSize === v }"
                  :data-testid="`setting-font-${v}`"
                  @click="save({ fontSize: v })"
                >
                  {{ label }}
                </button>
              </div>
            </div>

            <div class="ui-card setting-row is-actionable">
              <div class="sr-text">
                <div class="sr-label">Default view</div>
                <div class="sr-desc">What a session opens in — Clean summaries or the raw terminal</div>
              </div>
              <div class="ui-segments">
                <button
                  class="ui-seg"
                  :class="{ on: settings.defaultView === 'clean', 'is-on': settings.defaultView === 'clean' }"
                  data-testid="setting-view-clean"
                  @click="save({ defaultView: 'clean' })"
                >
                  Clean
                </button>
                <button
                  class="ui-seg"
                  :class="{ on: settings.defaultView === 'raw', 'is-on': settings.defaultView === 'raw' }"
                  data-testid="setting-view-raw"
                  @click="save({ defaultView: 'raw' })"
                >
                  Raw
                </button>
              </div>
            </div>

            <div class="ui-card setting-row is-actionable">
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

            <div class="ui-card setting-row is-actionable">
              <div class="sr-text">
                <div class="sr-label">Show injected context in Clean view</div>
                <div class="sr-desc">
                  System reminders, expanded slash commands and hook output — everything added to
                  your message before the model read it. Off: Clean view hides them. Raw view always
                  shows them in full.
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.showInjections }"
                data-testid="setting-injections"
                role="switch"
                :aria-checked="settings.showInjections"
                @click="save({ showInjections: !settings.showInjections })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="ui-card setting-row is-actionable">
              <div class="sr-text">
                <div class="sr-label">Session timer</div>
                <div class="sr-desc">
                  Show how long each session has been open, in the sidebar and the header
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: settings.showSessionTimer }"
                data-testid="setting-session-timer"
                role="switch"
                :aria-checked="settings.showSessionTimer"
                @click="save({ showSessionTimer: !settings.showSessionTimer })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="ui-card setting-row is-actionable">
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

            <div class="ui-card setting-row is-actionable">
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
                    the Agent tool is refused, whatever the mode below says.
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
                  How hard the advisor and worker subagents reason, once Effort is at max. At max
                  it also switches on divide and conquer: the session is told to split work into
                  independent parts and dispatch them to as many subagents as the work allows,
                  in one batch, and is pinned to the Orchestrator protocol so the two
                  instructions agree.
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

            <div class="ui-kicker group-label" style="margin-top: 8px">BYPASS SANDBOX</div>
            <div class="group-desc">
              Bypass sessions run in a WSL container capped at this much memory, so one
              hungry build stops alone instead of killing every session (exit 137). A size
              such as <span class="mono">6g</span> or <span class="mono">12g</span>, or
              <span class="mono">0</span> for no cap. Applies from the next bypass session.
            </div>
            <div class="ui-card setting-row is-actionable">
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

          <template v-else>
            <div class="ui-kicker group-label">NOTIFICATIONS</div>
            <div class="group-desc">How Switchboard gets your attention.</div>
            <div class="ui-card setting-row is-actionable">
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

            <div class="ui-kicker group-label" style="margin-top: 8px">APP UPDATES</div>
            <div class="group-desc">
              New versions are published to GitHub releases. Switchboard checks for a newer release
              and, when one exists, opens its download page so you can run the installer.
            </div>
            <div
              class="update-status"
              :class="updates.status.state === 'error' ? 'ui-err' : 'ui-card'"
              data-testid="update-status"
            >{{ updateLine }}</div>
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

            <div class="ui-card" style="margin-top: 8px">
              Raw output is kept for the current and previous session per project; decision history
              for 30 days. All data stays on this machine.
            </div>
          </template>
        </div>
      </div>

      <div class="s-foot">
        <span>Changes apply immediately</span>
        <span class="spacer"></span>
        <button class="btn-solid" data-testid="settings-done" @click="emit('close')">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
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

.overlay {
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

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
  color: var(--text-meta);
}

.s-title {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-bright);
}

.s-x {
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
  background: var(--bg-panel-2);
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
  color: var(--text-faint);
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
  padding: var(--sp-6) var(--sp-6) var(--sp-7);
  display: flex;
  flex-direction: column;
  gap: 12px;
  mask-image: linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%);
  mask-size: 100% calc(100% + 18px);
  mask-repeat: no-repeat;
}

.group {
  margin-bottom: 20px;
}

.group-label {
  margin-bottom: 4px;
}

.group-desc {
  font: 400 var(--fs-ui) / 1.5 var(--sans);
  color: var(--text-mid);
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
  text-align: left;
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
  border: 1px solid var(--border-strong);
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
  font-weight: var(--w-em);
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

.mcp-check {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: var(--rc);
  border: 1px solid var(--border-strong);
  color: var(--green-ink);
  display: flex;
  align-items: center;
  justify-content: center;
}

.mcp-check.on {
  border-color: var(--green);
  background: var(--green);
}

.mcp-ico {
  flex-shrink: 0;
  color: var(--teal);
}

.mcp-opt {
  padding: 11px 13px;
  gap: 12px;
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

.sandbox-mem-input {
  flex: 0 0 72px;
  text-align: right;
  padding: 5px 9px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--rc);
}

.proj-card {
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
  min-height: 42px;
  padding: 9px 13px;
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  text-align: left;
  border-radius: var(--r-panel);
  transition: border-color 120ms var(--ease), box-shadow 120ms var(--ease);
}

.dd.open {
  border-color: var(--green);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 16%, transparent);
}

.dd-arrow {
  transition: transform 160ms var(--ease-overlay);
}

.dd-arrow.open {
  transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
  .dd,
  .dd-arrow {
    transition: none;
  }
}

.dd:hover {
  border-color: var(--green);
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
  font-weight: var(--w-em);
  color: var(--text-strong);
}

.dd-arrow {
  color: var(--text-tab);
}

.dd-list {
  top: calc(100% + 6px);
  bottom: auto;
  padding: 0;
  overflow: hidden;
  animation: ddIn 160ms var(--ease-overlay);
}

@keyframes ddIn {
  from {
    opacity: 0;
    transform: scale(0.98) translateY(-4px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dd-list {
    animation: none;
  }
}

.dd-search {
  width: 100%;
  padding: 9px 12px;
  font-size: var(--fs-ui);
  color: var(--text);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border);
}

.dd-search:focus {
  outline: none;
}

.dd-scroll {
  max-height: 260px;
  overflow-y: auto;
  padding: 6px;
}

.dd-empty {
  padding: 12px;
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

.dd-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
}

.dd-item:hover {
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.dd-item.sel {
  background: color-mix(in srgb, var(--green) 7%, transparent);
  color: var(--text-strong);
}

.dd-check {
  display: inline-flex;
  width: 12px;
  min-width: 12px;
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
}

.sr-text {
  flex: 1;
  min-width: 0;
}

.sr-label {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-title);
}

.sr-desc {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  margin-top: 2px;
  line-height: 1.5;
  text-wrap: pretty;
}

.sr-warn {
  display: block;
  margin-top: 5px;
  font-weight: 400;
  color: var(--text-body);
}

.seg-auto.is-on {
  background: color-mix(in srgb, var(--green) 15%, transparent);
  color: var(--green);
}

.update-status {
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

.switch {
  border-radius: var(--rc);
}

.switch .knob {
  border-radius: var(--rc);
}
.skills-caution {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--amber);
}

.skills-err {
  margin-top: 8px;
  font-size: var(--fs-meta);
  color: var(--red);
}

.skills-skipped {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.skipped-head {
  color: var(--text-mid);
}

.skipped-one {
  display: flex;
  gap: 6px;
  padding-left: 8px;
}

.skipped-name {
  color: var(--text-mid);
  flex-shrink: 0;
}

.skipped-why {
  min-width: 0;
  color: var(--text-faint);
}


.skill-reading {
  margin-top: 6px;
  font-size: var(--fs-micro);
}

.skill-reading-parts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}

.skill-part {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
}

.skill-part-label {
  letter-spacing: 0.05em;
  color: var(--text-ghost);
}

.skill-part-value {
  color: var(--text-name);
  overflow-wrap: anywhere;
}

.skill-reading-bad {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--amber);
}

.add-cmd-input.bad {
  color: var(--amber-ink);
}


.skill-group {
  margin-bottom: 14px;
}

.skill-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 2px;
  font-size: var(--fs-micro);
}

.skill-group-name {
  color: var(--text-name);
  overflow-wrap: anywhere;
}

.skill-group-count {
  color: var(--text-ghost);
}

.skill-group-all {
  margin-left: auto;
  padding: 1px 6px;
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--text-faint);
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--r-row);
}

.skill-group-all:hover {
  color: var(--text-bright);
  border-color: var(--blue);
}

.skills-origin {
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

.skills-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skills-remove {
  display: inline-flex;
  padding: 3px;
  color: var(--text-faint);
  background: none;
  border: 0;
  cursor: pointer;
}

.skills-remove:hover {
  color: var(--red);
}
</style>
