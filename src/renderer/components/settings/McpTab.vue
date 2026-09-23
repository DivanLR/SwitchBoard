<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useProjectsStore } from '@renderer/stores/projects'
import Icon from '@renderer/components/Icon.vue'

const store = useSettingsStore()
const projects = useProjectsStore()
const settings = computed(() => store.settings)

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
  void store.save({ databaseMcpServers: next, mcpActiveServers: nextActive })
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
</script>

<template>
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

<style scoped>
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

.card-opt.mcp-opt {
  padding: 11px 13px;
  gap: 12px;
}
</style>
