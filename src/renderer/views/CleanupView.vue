<script setup lang="ts">
// Cleanup section — a launcher of curated code-review and cleanup commands from
// the dotnet-claude-kit and ponytail plugins. Each group is install-aware: when
// the plugin's commands are available in the session it shows runnable command
// rows; otherwise it shows a "download to project" card that installs it. A
// command row sends its slash command to the session (output streams there).
import { computed } from 'vue'
import { CLEANUP_GROUPS, type CleanupGroup } from '@shared/domain'
import { normalizeForMatch } from '@renderer/composables/useCommandSuggestions'

const props = defineProps<{
  projectName: string
  /** Available slash-command names for this project (drives install state). */
  available: string[]
}>()

const emit = defineEmits<{
  (e: 'run', command: string): void
  (e: 'install', group: CleanupGroup): void
}>()

// A group counts as installed when any of its commands is available. Before the
// session's command list has loaded (empty), assume installed so the useful
// command rows show rather than a flash of download cards.
const availableKeys = computed(() => new Set(props.available.map(normalizeForMatch)))
function isInstalled(g: CleanupGroup): boolean {
  if (props.available.length === 0) return true
  return g.commands.some((c) => availableKeys.value.has(normalizeForMatch(c.command)))
}

function run(command: string): void {
  emit('run', `/${command}`)
}
</script>

<template>
  <div class="cleanup" data-testid="cleanup-view">
    <div class="intro">
      Suggested commands to run code reviews and cleanups on
      <span class="proj">{{ projectName }}</span>. Click any command to run it in the session.
    </div>

    <div v-for="g in CLEANUP_GROUPS" :key="g.source" class="group">
      <div class="group-head">
        <span class="group-name mono">{{ g.source }}</span>
        <span class="group-tag">{{ g.tag }}</span>
        <span style="flex: 1"></span>
        <span v-if="isInstalled(g)" class="badge installed">✓ Installed</span>
        <span v-else class="badge missing">○ Not installed</span>
      </div>
      <div class="group-blurb">{{ g.blurb }}</div>

      <div v-if="isInstalled(g)" class="cmd-list">
        <button
          v-for="c in g.commands"
          :key="c.command"
          class="cmd-row"
          :data-testid="`cleanup-cmd-${c.command}`"
          @click="run(c.command)"
        >
          <span class="cmd-name mono">{{ c.label }}</span>
          <span class="cmd-desc">{{ c.hint }}</span>
          <span class="cmd-run">Run →</span>
        </button>
      </div>

      <div v-else class="install-card">
        <div class="install-text">
          <div class="install-title">Not installed in this project — add it to run these commands</div>
          <div class="install-cmds mono">{{ g.marketplace }} · {{ g.pkg }}</div>
        </div>
        <button
          class="install-btn"
          :data-testid="`cleanup-install-${g.source}`"
          @click="emit('install', g)"
        >
          ⤓ Download to project
        </button>
      </div>
    </div>
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
  font-size: 12.8px;
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
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-bright);
}

.group-tag {
  font-size: 10.5px;
  color: var(--text-faint);
}

.badge {
  font-size: 10px;
  border-radius: 99px;
  padding: 1px 9px;
  white-space: nowrap;
}

.badge.installed {
  color: var(--green);
  background: rgba(52, 211, 153, 0.1);
  border: 1px solid rgba(52, 211, 153, 0.32);
}

.badge.missing {
  color: var(--amber);
  background: rgba(154, 111, 42, 0.12);
  border: 1px solid rgba(154, 111, 42, 0.35);
}

.group-blurb {
  font-size: 11.5px;
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
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
  text-align: left;
}

.cmd-row:hover {
  border-color: var(--green);
}

.cmd-name {
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--green);
  white-space: nowrap;
}

.cmd-desc {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-mid);
  text-wrap: pretty;
}

.cmd-run {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
}

.install-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 15px;
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
}

.install-text {
  flex: 1;
  min-width: 0;
}

.install-title {
  font-size: 12px;
  color: var(--text-body);
}

.install-cmds {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
  margin-top: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.install-btn {
  flex-shrink: 0;
  white-space: nowrap;
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
  color: var(--green-ink);
  font-weight: 600;
  font-size: 11.5px;
  padding: 8px 15px;
  border-radius: var(--rc);
  cursor: pointer;
  user-select: none;
  box-shadow: var(--green-glow);
}

.install-btn:hover {
  background: var(--green-hover);
}
</style>
