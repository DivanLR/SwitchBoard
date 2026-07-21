<script setup lang="ts">
// Settings modal — 1:1 with the design reference: header, left icon-tab rail
// (Models / This project / Terminals / General) with a Plan/Build footer,
// card + toggle + segmented controls, and a "Changes apply immediately · Done"
// footer. State and transport live in the settings store.
import { computed, onMounted, ref, watch } from 'vue'
import type { PermissionRule, Settings, TerseLevel } from '@shared/domain'
import { MODEL_CHOICES } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'
import { useProjectsStore } from '@renderer/stores/projects'
import { useUpdatesStore } from '@renderer/stores/updates'

const props = defineProps<{ initialTab?: 'models' | 'proj' | 'allowed' | 'term' | 'gen' }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const store = useSettingsStore()
const projects = useProjectsStore()
const updates = useUpdatesStore()
const settings = computed(() => store.settings)

type Tab = 'models' | 'proj' | 'allowed' | 'term' | 'gen'
const tab = ref<Tab>(props.initialTab ?? 'models')
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'models', label: 'Models', icon: '✦' },
  { id: 'proj', label: 'This project', icon: '▣' },
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
// Plugins / skills the project's sessions can load (from the session init message).
const plugins = ref<string[]>([])

watch(
  () => proj.value?.id,
  async (id) => {
    plugins.value = id
      ? (await window.switchboard.invoke('projects.commands', { projectId: id })).map((c) => c.name)
      : []
  },
  { immediate: true },
)

onMounted(() => {
  void store.load()
  projId.value = projects.selectedProjectId
})

function save(patch: Partial<Settings>): void {
  void store.save(patch)
}

/** Per-project implementation model: 'global' follows the Models tab. */
const projModel = computed(() => {
  const id = proj.value?.id
  return (id && settings.value?.projectModels?.[id]) || 'global'
})

function saveProjModel(modelId: string): void {
  if (!proj.value || !settings.value) return
  save({ projectModels: { ...settings.value.projectModels, [proj.value.id]: modelId } })
}

const terseExplain: Record<TerseLevel, string> = {
  lite: 'Light touch: drops filler and pleasantries, keeps full sentences.',
  full: 'Compact: fragments and bullets, conclusion first, no preamble.',
  ultra: 'Maximum: telegraphic notes only. Densest, least conversational.',
}

function modelLabel(id: string): string {
  return MODEL_CHOICES.find((m) => m.id === id)?.label ?? id
}

// --- Allowed list tab (design): risk auto-approve + per-project command rules ---
const allowedRules = ref<PermissionRule[]>([])
const newCmd = ref('')

const MATCHER_KIND_LABEL: Record<string, string> = {
  command_prefix: 'Commands starting with this',
  path_glob: 'Files under this folder',
  exact_input: 'This exact action only',
  tool_only: 'Any use of this tool',
}

async function loadAllowedRules(): Promise<void> {
  allowedRules.value = proj.value
    ? await window.switchboard.invoke('rules.standing.list', {
        projectId: proj.value.id,
        includeRevoked: true,
      })
    : []
}

watch(
  [() => proj.value?.id, tab],
  () => {
    if (tab.value === 'allowed') void loadAllowedRules()
  },
  { immediate: true },
)

async function setRuleMode(rule: PermissionRule, mode: 'ask' | 'auto'): Promise<void> {
  if (mode === 'ask' && rule.revokedAt === null) {
    await window.switchboard.invoke('rules.standing.revoke', { ruleId: rule.id })
  } else if (mode === 'auto' && rule.revokedAt !== null) {
    await window.switchboard.invoke('rules.standing.restore', { ruleId: rule.id })
  }
  await loadAllowedRules()
}

async function addAllowedCommand(): Promise<void> {
  const pattern = newCmd.value.trim()
  if (!pattern || !proj.value) return
  newCmd.value = ''
  await window.switchboard.invoke('rules.standing.add', { projectId: proj.value.id, pattern })
  await loadAllowedRules()
}

// --- Plugin toggles (design): hide a plugin's commands from suggestions ---
const disabledPlugins = computed(
  () => (proj.value && settings.value?.disabledCommands?.[proj.value.id]) || [],
)

function togglePlugin(name: string): void {
  if (!proj.value || !settings.value) return
  const id = proj.value.id
  const current = settings.value.disabledCommands?.[id] ?? []
  const next = current.includes(name) ? current.filter((c) => c !== name) : [...current, name]
  save({ disabledCommands: { ...settings.value.disabledCommands, [id]: next } })
}

const updateLine = computed(() => {
  const s = updates.status
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Update ${s.version ?? ''} available — downloading…`
    case 'downloading':
      return `Downloading update… ${s.percent ?? 0}%`
    case 'ready':
      return `Update ${s.version ?? ''} ready. Restart to apply.`
    case 'none':
      return 'You are on the latest version.'
    case 'error':
      return `Update check failed: ${s.message ?? 'unknown error'}`
    default:
      return 'Updates are delivered from GitHub releases.'
  }
})
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog settings" data-testid="settings-panel">
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
            Plan {{ modelLabel(settings.planModel) }}<br />Build {{ modelLabel(settings.workModel) }}
          </div>
        </div>

        <!-- Content pane -->
        <div v-if="settings" class="s-body">
          <!-- MODELS -->
          <template v-if="tab === 'models'">
            <div class="group">
              <div class="group-label mono">PLANNING MODEL</div>
              <div class="group-desc">
                Reads the codebase, weighs approaches, and writes the plan — before any code is
                touched.
              </div>
              <div class="cards">
                <button
                  v-for="m in MODEL_CHOICES"
                  :key="m.id"
                  class="card-opt"
                  :class="{ sel: settings.planModel === m.id }"
                  :data-testid="`plan-model-${m.id}`"
                  @click="save({ planModel: m.id })"
                >
                  <span class="opt-dot" :class="{ on: settings.planModel === m.id }"></span>
                  <div class="opt-body">
                    <div class="opt-name mono">{{ m.label }}</div>
                    <div class="opt-sub">{{ m.desc }}</div>
                  </div>
                  <span class="opt-price mono">{{ m.price }}</span>
                </button>
              </div>
            </div>

            <div class="group">
              <div class="group-label mono">IMPLEMENTATION MODEL</div>
              <div class="group-desc">Executes the plan — edits files, runs commands, writes tests.</div>
              <div class="cards">
                <button
                  v-for="m in MODEL_CHOICES"
                  :key="m.id"
                  class="card-opt"
                  :class="{ sel: settings.workModel === m.id }"
                  :data-testid="`work-model-${m.id}`"
                  @click="save({ workModel: m.id })"
                >
                  <span class="opt-dot" :class="{ on: settings.workModel === m.id }"></span>
                  <div class="opt-body">
                    <div class="opt-name mono">{{ m.label }}</div>
                    <div class="opt-sub">{{ m.desc }}</div>
                  </div>
                  <span class="opt-price mono">{{ m.price }}</span>
                </button>
              </div>
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

              <div class="group">
                <div class="group-label mono">IMPLEMENTATION MODEL</div>
                <div class="group-desc">
                  Overrides the global default — writes code and runs commands in this project only.
                </div>
                <div class="cards">
                  <button
                    class="card-opt"
                    :class="{ sel: projModel === 'global' }"
                    data-testid="proj-model-global"
                    @click="saveProjModel('global')"
                  >
                    <span class="opt-dot" :class="{ on: projModel === 'global' }"></span>
                    <div class="opt-body">
                      <div class="opt-name mono">Use global default</div>
                      <div class="opt-sub">Follows the Models tab ({{ modelLabel(settings.workModel) }})</div>
                    </div>
                    <span class="opt-price mono">—</span>
                  </button>
                  <button
                    v-for="m in MODEL_CHOICES"
                    :key="m.id"
                    class="card-opt"
                    :class="{ sel: projModel === m.id }"
                    :data-testid="`proj-model-${m.id}`"
                    @click="saveProjModel(m.id)"
                  >
                    <span class="opt-dot" :class="{ on: projModel === m.id }"></span>
                    <div class="opt-body">
                      <div class="opt-name mono">{{ m.label }}</div>
                      <div class="opt-sub">{{ m.desc }}</div>
                    </div>
                    <span class="opt-price mono">{{ m.price }}</span>
                  </button>
                </div>
              </div>

              <div class="group">
                <div class="group-label mono">PLUGINS</div>
                <div class="group-desc">Tools Claude can load in this project's sessions.</div>
                <div v-if="plugins.length === 0" class="note">
                  Nothing reported yet — plugins and skills appear here after the project's first
                  session starts.
                </div>
                <div v-else class="cards" data-testid="proj-plugins">
                  <div v-for="p in plugins" :key="p" class="card-opt static">
                    <div class="opt-body">
                      <div class="opt-name mono">{{ p }}</div>
                      <div class="opt-sub">
                        {{
                          disabledPlugins.includes(p)
                            ? 'Hidden from composer suggestions'
                            : 'Suggested in the composer'
                        }}
                      </div>
                    </div>
                    <button
                      class="toggle"
                      :class="{ on: !disabledPlugins.includes(p) }"
                      :data-testid="`plugin-toggle-${p}`"
                      role="switch"
                      :aria-checked="!disabledPlugins.includes(p)"
                      @click="togglePlugin(p)"
                    >
                      <span class="knob"></span>
                    </button>
                  </div>
                </div>
              </div>
            </template>
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
                class="toggle"
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
                class="toggle"
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
                    class="seg-opt"
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
              <input
                v-model="newCmd"
                class="add-cmd-input mono"
                data-testid="allowed-add-input"
                placeholder="+ Add a command — e.g. make build"
                @keydown.enter="addAllowedCommand"
              />
              <button class="btn-solid" data-testid="allowed-add-btn" @click="addAllowedCommand">
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
                  v-for="[v, label] in ([['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] as const)"
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
                class="toggle"
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
                class="toggle"
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
                class="toggle"
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
                <div class="sr-label">Terse mode</div>
                <div class="sr-desc">
                  Compresses only Claude's replies to you (output tokens), saving cost and time. Your
                  prompts and the context Claude reads are unchanged; code, commands, and errors stay
                  exact.
                </div>
              </div>
              <button
                class="toggle"
                :class="{ on: settings.terseMode }"
                data-testid="setting-terse-mode"
                role="switch"
                :aria-checked="settings.terseMode"
                @click="save({ terseMode: !settings.terseMode })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div v-if="settings.terseMode" class="group">
              <div class="group-label mono">TERSE LEVEL</div>
              <div class="group-desc">How aggressively replies are compressed.</div>
              <div class="cards">
                <button
                  v-for="level in (['lite', 'full', 'ultra'] as const)"
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
                class="toggle"
                :class="{ on: settings.notificationsEnabled }"
                data-testid="setting-notifications"
                role="switch"
                :aria-checked="settings.notificationsEnabled"
                @click="save({ notificationsEnabled: !settings.notificationsEnabled })"
              >
                <span class="knob"></span>
              </button>
            </div>

            <div class="group-label mono" style="margin-top: 8px">APPROVALS &amp; SPEND</div>
            <div class="setting-row">
              <div class="sr-text">
                <div class="sr-label">Daily spend limit</div>
                <div class="sr-desc">Cost today turns red in the sidebar once passed</div>
              </div>
              <div class="seg mono">
                <button
                  v-for="[v, label] in ([[0, 'Off'], [5, '$5'], [10, '$10'], [25, '$25'], [50, '$50']] as const)"
                  :key="v"
                  class="seg-opt"
                  :class="{ on: settings.dailySpendLimit === v }"
                  :data-testid="`spend-limit-${v}`"
                  @click="save({ dailySpendLimit: v })"
                >
                  {{ label }}
                </button>
              </div>
            </div>

            <div class="group-label mono" style="margin-top: 8px">APP UPDATES</div>
            <div class="group-desc">
              New versions are published to GitHub releases and downloaded automatically. When one is
              ready, restart to apply it.
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
                v-if="updates.ready"
                class="btn-solid"
                data-testid="update-install"
                @click="updates.install()"
              >
                Restart &amp; update
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
  width: 730px;
  max-width: 94vw;
  height: 580px;
  max-height: 88vh;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.s-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.gear {
  font-size: 13px;
  color: var(--text-meta);
}

.s-title {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-bright);
}

.s-x {
  font-size: 13px;
  color: var(--text-tab);
  padding: 2px 8px;
  border-radius: 10px;
  background: transparent;
}

.s-x:hover {
  color: var(--text-strong);
  background: var(--bg-chip);
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
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
  background: transparent;
  text-align: left;
}

.rail-tab:hover {
  background: var(--bg-card);
}

.rail-tab.sel {
  background: var(--bg-active);
  border-color: var(--border-strong);
}

.rt-icon {
  font-size: 11px;
  color: var(--text-faint);
  width: 13px;
}

.rail-tab.sel .rt-icon {
  color: var(--green);
}

.rt-label {
  font-size: 11.5px;
  color: var(--text-meta);
}

.rail-tab.sel .rt-label {
  color: var(--text-strong);
}

.rail-foot {
  padding: 9px 11px;
  font-size: 10px;
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
  margin-bottom: 8px;
}

.group-label {
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--text-faint);
  margin-bottom: 4px;
}

.group-desc {
  font-size: 12px;
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
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
}

.card-opt:hover:not(.static) {
  border-color: var(--border-strong);
}

.card-opt.sel {
  background: rgba(30, 122, 92, 0.06);
  border-color: rgba(30, 122, 92, 0.4);
}

.card-opt.static {
  cursor: default;
}

.opt-dot {
  width: 8px;
  min-width: 8px;
  height: 8px;
  border-radius: 99px;
  border: 1.5px solid var(--border-strong);
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
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-body);
}

.card-opt.sel .opt-name {
  color: var(--text-strong);
}

.opt-sub {
  font-size: 11.5px;
  color: var(--text-meta);
  margin-top: 2px;
}

.opt-price {
  font-size: 10.5px;
  color: var(--text-faint);
  flex-shrink: 0;
}

.lock-chip {
  font-size: 10px;
  color: var(--amber);
  border: 1px solid rgba(154, 111, 42, 0.35);
  padding: 1px 7px;
  flex-shrink: 0;
}

.add-cmd {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.add-cmd-input {
  flex: 1;
  font-size: 11.5px;
  padding: 8px 12px;
  background: var(--bg-code);
  border: 1px dashed var(--border-strong);
  color: var(--text-body);
  outline: none;
}

.add-cmd-input:focus {
  border-color: var(--green);
  border-style: solid;
}

.proj-card {
  padding: 11px 12px;
  background: var(--bg-card-alt);
  border: 1px solid var(--border-card-alt);
  border-radius: 10px;
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
  background: var(--bg-chip);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
}

.dd:hover {
  border-color: var(--border-seg);
}

.dd-dot {
  width: 8px;
  min-width: 8px;
  height: 8px;
  border-radius: 99px;
  background: var(--green);
}

.dd-name {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-strong);
}

.dd-arrow {
  font-size: 10px;
  color: var(--text-tab);
}

.dd-list {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  right: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  overflow: hidden;
  z-index: 10;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  animation: sbIn 0.15s ease;
}

.dd-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 13px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-mid);
  background: transparent;
  text-align: left;
}

.dd-item:hover {
  background: var(--bg-chip);
}

.dd-item.sel {
  background: rgba(30, 122, 92, 0.07);
  color: var(--text-strong);
}

.dd-check {
  width: 12px;
  min-width: 12px;
  font-size: 11px;
  color: var(--green);
}

.proj-note {
  font-size: 11.5px;
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
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 10px;
}

.sr-text {
  flex: 1;
  min-width: 0;
}

.sr-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
}

.sr-desc {
  font-size: 11.5px;
  color: var(--text-tab);
  margin-top: 2px;
  line-height: 1.5;
  text-wrap: pretty;
}

.toggle {
  width: 38px;
  min-width: 38px;
  height: 21px;
  border-radius: 99px;
  background: var(--border-strong);
  position: relative;
  cursor: pointer;
  border: none;
}

.toggle.on {
  background: var(--green);
}

.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 17px;
  height: 17px;
  border-radius: 99px;
  background: var(--text-faint);
  transition: all 0.15s ease;
}

.toggle.on .knob {
  left: auto;
  right: 2px;
  background: var(--bg);
}

.seg {
  display: flex;
  flex-shrink: 0;
  border: 1px solid var(--border-seg);
  border-radius: 99px;
  overflow: hidden;
}

.seg-opt {
  padding: 5px 12px;
  font-size: 11px;
  color: var(--text-tab);
  cursor: pointer;
  background: transparent;
}

.seg-opt:hover {
  color: var(--text-body);
}

.seg-opt.on {
  background: var(--bg-seg);
  color: var(--text-strong);
}

.note {
  padding: 10px 13px;
  background: var(--bg-card-alt);
  border: 1px solid var(--border-card-alt);
  border-radius: 10px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-meta);
}

.update-status {
  font-size: 12px;
  color: var(--text-body);
  padding: 10px 13px;
  background: var(--bg-card-alt);
  border: 1px solid var(--border-card-alt);
  border-radius: 10px;
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
  font-size: 10.5px;
  color: var(--text-faint);
}
</style>
