<script setup lang="ts">
import { computed } from 'vue'
import { CLEANUP_GROUPS, type CleanupCommand, type CleanupGroup } from '@shared/command-catalog'
import { normalizeForMatch } from '@renderer/composables/useCommandSuggestions'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  projectName: string
  available: string[]
  sessionId?: string | null
  installing?: boolean
  installError?: string | null
}>()

const emit = defineEmits<{
  (e: 'run', command: string): void
  (e: 'install', group: CleanupGroup): void
}>()

const availableByName = computed(() => {
  const byName = new Map<string, string>()
  for (const full of props.available) {
    const own = full.slice(full.lastIndexOf(':') + 1)
    const key = normalizeForMatch(own)
    if (!byName.has(key) || full.includes(':')) byName.set(key, full)
  }
  return byName
})

function isInstalled(g: CleanupGroup): boolean {
  if (props.available.length === 0) return true
  return g.commands.some((c) => availableByName.value.has(normalizeForMatch(c.command)))
}

function isAvailable(c: CleanupCommand): boolean {
  if (props.available.length === 0) return true
  return availableByName.value.has(normalizeForMatch(c.command))
}

const groups = computed(() => CLEANUP_GROUPS.filter((g) => !g.stackSpecific || isInstalled(g)))

function run(command: string): void {
  const resolved = availableByName.value.get(normalizeForMatch(command)) ?? command
  emit('run', resolved.startsWith('/') ? resolved : `/${resolved}`)
}
</script>

<template>
  <div class="cleanup" data-testid="cleanup-view">
    <div class="intro">
      Suggested commands to run code reviews and cleanups on
      <span class="proj">{{ projectName }}</span>. Click any command to run it in the session.
    </div>

    <div v-for="g in groups" :key="g.source" class="group">
      <div class="group-head">
        <span class="group-name mono">{{ g.source }}</span>
        <span class="group-tag">{{ g.tag }}</span>
        <span class="spacer"></span>
        <span v-if="isInstalled(g)" class="badge installed"><Icon name="check" :size="11" /> Installed</span>
        <span v-else class="badge missing"><Icon name="circle" :size="11" /> Not installed</span>
      </div>
      <div class="group-blurb">{{ g.blurb }}</div>

      <div v-if="isInstalled(g)" class="cmd-list">
        <button
          v-for="c in g.commands"
          :key="c.command"
          class="cmd-row"
          :data-testid="`cleanup-cmd-${c.command}`"
          :disabled="!isAvailable(c)"
          :title="
            isAvailable(c)
              ? undefined
              : `${c.label} is not in this session's command list. The plugin may not ship it, or it may have been renamed.`
          "
          @click="run(c.command)"
        >
          <span class="cmd-name mono">{{ c.label }}</span>
          <span class="cmd-desc">{{ c.hint }}</span>
          <span class="cmd-run">
            <template v-if="isAvailable(c)">Run <Icon name="arrow-right" :size="11" /></template>
            <template v-else>Not available</template>
          </span>
        </button>
      </div>

      <div v-else class="install-card">
        <div class="install-text">
          <div class="install-title">Not installed in this project — add it to run these commands</div>
          <div class="install-cmds mono">{{ g.marketplace }} · {{ g.pkg }}</div>
          <div v-if="installError" class="install-error" :data-testid="`cleanup-install-error-${g.source}`">
            {{ installError }}
          </div>
        </div>
        <button
          class="install-btn"
          :data-testid="`cleanup-install-${g.source}`"
          :disabled="installing"
          @click="emit('install', g)"
        >
          <template v-if="installing">Installing…</template>
          <template v-else><Icon name="download" :size="12" /> Download to project</template>
        </button>
      </div>
    </div>

    <MiniTerminal v-if="sessionId" :session-id="sessionId" label="running" />
  </div>
</template>

<style scoped>
.cleanup {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 52px;
}

.intro {
  max-width: 840px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-mid);
  margin-bottom: 18px;
  text-wrap: pretty;
}

.intro .proj {
  color: var(--text-body);
}

.group {
  max-width: 840px;
  margin-bottom: 22px;
}

.group-head {
  display: flex;
  align-items: baseline;
  gap: 9px;
  margin-bottom: 3px;
  flex-wrap: wrap;
}

.group-name {
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-bright);
}

.group-tag {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.badge {
  font-size: var(--fs-micro);
  border-radius: var(--rp);
  padding: 1px 9px;
  white-space: nowrap;
}

.badge.installed {
  color: var(--green);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--green) 32%, transparent);
}

.badge.missing {
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
}

.group-blurb {
  font-size: var(--fs-meta);
  color: var(--text-tab);
  line-height: 1.55;
  margin-bottom: 11px;
  text-wrap: pretty;
}

.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.cmd-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 13px;
  background: var(--bg-card);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
  text-align: left;
}

.cmd-row:hover:not(:disabled) {
  border-color: var(--green);
}

.cmd-row:disabled {
  cursor: default;
  opacity: 0.55;
}

.cmd-name {
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: var(--fs-meta);
  color: var(--green);
  white-space: nowrap;
}

.cmd-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--text-mid);
  text-wrap: pretty;
}

.cmd-run {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
}

.install-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 15px;
  background: var(--bg-card);
  box-shadow: var(--elev);
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
}

.install-text {
  flex: 1;
  min-width: 0;
}

.install-title {
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.install-error {
  margin-top: 6px;
  font-size: var(--fs-micro);
  color: var(--red);
}

.install-cmds {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--text-faint);
  margin-top: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.install-btn {
  flex-shrink: 0;
  white-space: nowrap;
  background: var(--green);
  color: var(--green-ink);
  font-weight: var(--w-em);
  font-size: var(--fs-meta);
  padding: 8px 15px;
  border-radius: var(--rc);
  cursor: pointer;
  user-select: none;
}

.install-btn:hover {
  background: var(--green-hover);
}
</style>
