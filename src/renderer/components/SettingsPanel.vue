<script setup lang="ts">
import { useTemplateRef, computed, onMounted, ref } from 'vue'
import { useModal } from '@renderer/composables/useModal'
import { modelLabel } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'
import { useProjectsStore } from '@renderer/stores/projects'
import Icon from '@renderer/components/Icon.vue'
import ModelsTab from '@renderer/components/settings/ModelsTab.vue'
import ProjectsTab from '@renderer/components/settings/ProjectsTab.vue'
import McpTab from '@renderer/components/settings/McpTab.vue'
import AllowedTab from '@renderer/components/settings/AllowedTab.vue'
import DisplayTab from '@renderer/components/settings/DisplayTab.vue'
import GeneralTab from '@renderer/components/settings/GeneralTab.vue'
import SkillsTab from '@renderer/components/settings/SkillsTab.vue'

export type SettingsTab = 'models' | 'proj' | 'mcp' | 'allowed' | 'skills' | 'term' | 'gen'

const props = defineProps<{ initialTab?: SettingsTab }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = useTemplateRef<HTMLElement>('dialog')
useModal(dialogEl, () => emit('close'))
const store = useSettingsStore()

const projects = useProjectsStore()
const settings = computed(() => store.settings)

const tab = ref<SettingsTab>(props.initialTab ?? 'models')
const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'models', label: 'Models', icon: 'spark' },
  { id: 'proj', label: 'Projects', icon: 'folder' },
  { id: 'mcp', label: 'MCP', icon: 'database' },
  { id: 'allowed', label: 'Allowed list', icon: 'square-check' },
  { id: 'skills', label: 'Skills', icon: 'spark' },
  { id: 'term', label: 'Display', icon: 'terminal' },
  { id: 'gen', label: 'General', icon: 'settings' },
]

const projId = ref<string | null>(null)
const proj = computed(
  () => projects.items.find((p) => p.id === projId.value) ?? projects.items[0] ?? null,
)

onMounted(() => {
  void store.load()
  projId.value = projects.selectedProjectId
  void store.loadAvailableModels()
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
            {{ modelLabel(settings.model) }}
          </div>
        </div>

        <div v-if="settings" class="s-body">
          <ModelsTab v-if="tab === 'models'" :settings="settings" />
          <ProjectsTab v-else-if="tab === 'proj'" :project="proj" @choose="projId = $event" />
          <McpTab v-else-if="tab === 'mcp'" />
          <AllowedTab v-else-if="tab === 'allowed'" :settings="settings" :project="proj" />
          <SkillsTab v-else-if="tab === 'skills'" />
          <DisplayTab v-else-if="tab === 'term'" :settings="settings" />
          <GeneralTab v-else :settings="settings" />
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

:deep(.group) {
  margin-bottom: 20px;
}

:deep(.group-label) {
  margin-bottom: 4px;
}

:deep(.group-desc) {
  font: 400 var(--fs-ui) / 1.5 var(--sans);
  color: var(--text-mid);
  margin-bottom: 10px;
  text-wrap: pretty;
}

:deep(.cards) {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

:deep(.card-opt) {
  display: flex;
  align-items: center;
  gap: 11px;
  text-align: left;
}

:deep(.card-opt.static .opt-name) {
  font-size: var(--fs-body);
  color: var(--text-title);
}

:deep(.card-opt:not(.sel) .opt-sub) {
  color: var(--text-tab);
}

:deep(.opt-dot) {
  width: 8px;
  min-width: 8px;
  height: 8px;
  border-radius: var(--rp);
  border: 1px solid var(--border-strong);
}

:deep(.opt-dot.on) {
  background: var(--green);
  border-color: var(--green);
}

:deep(.opt-body) {
  flex: 1;
  min-width: 0;
}

:deep(.opt-name) {
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-body);
}

:deep(.card-opt.sel .opt-name) {
  color: var(--text-strong);
}

:deep(.opt-sub) {
  font-size: var(--fs-meta);
  color: var(--text-meta);
  margin-top: 2px;
}

:deep(.opt-price) {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  flex-shrink: 0;
}

:deep(.add-cmd) {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 10px 13px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
}

:deep(.add-cmd-plus) {
  flex-shrink: 0;
  color: var(--green);
}

:deep(.add-cmd-input) {
  flex: 1;
  min-width: 60px;
  font-size: var(--fs-ui);
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-name);
  outline: none;
}

:deep(.proj-name) {
  color: var(--text-body);
}

:deep(.setting-row) {
  display: flex;
  align-items: center;
  gap: 12px;
}

:deep(.sr-text) {
  flex: 1;
  min-width: 0;
}

:deep(.sr-label) {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-title);
}

:deep(.sr-desc) {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  margin-top: 2px;
  line-height: 1.5;
  text-wrap: pretty;
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

:deep(.switch) {
  border-radius: var(--rc);
}

:deep(.switch .knob) {
  border-radius: var(--rc);
}
</style>
