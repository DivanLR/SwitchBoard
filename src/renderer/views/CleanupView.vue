<script setup lang="ts">
// Cleanup section — a launcher of curated code-review and cleanup commands from
// the dotnet-claude-kit and ponytail plugins. Each group is install-aware: when
// the plugin's commands are available in the session it shows runnable command
// rows; otherwise it shows a "download to project" card that installs it. A
// command row sends its slash command to the session (output streams there).
import { computed } from 'vue'
import { CLEANUP_GROUPS, type CleanupCommand, type CleanupGroup } from '@shared/command-catalog'
import { normalizeForMatch } from '@renderer/composables/useCommandSuggestions'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'

const props = defineProps<{
  projectName: string
  /** Available slash-command names for this project (drives install state). */
  available: string[]
  /** The background session a command was last sent to, for the terminal below. */
  sessionId?: string | null
  /** True while a plugin install is running on the host. */
  installing?: boolean
  /** Why the install failed, in the CLI's own words. */
  installError?: string | null
}>()

const emit = defineEmits<{
  (e: 'run', command: string): void
  (e: 'install', group: CleanupGroup): void
}>()

/**
 * The session's own command list, keyed by each command's OWN name.
 *
 * A plugin's commands arrive namespaced (`dotnet-claude-kit:de-sloppify`,
 * `ponytail:ponytail-review`); the catalogue names them bare. Matching the whole
 * string doesn't work — normalizeForMatch strips the colon, so the namespaced
 * form reduces to one long run that never equals the bare name. That bug had an
 * installed toolkit reporting five of its seven commands unavailable, and
 * ponytail as not installed at all; only `code-review` and `verify` matched,
 * because Claude Code ships built-ins under those bare names too.
 *
 * The value is the name AS THE SESSION KNOWS IT, so a row runs the plugin's own
 * command rather than a same-named built-in.
 */
const availableByName = computed(() => {
  const byName = new Map<string, string>()
  for (const full of props.available) {
    const own = full.slice(full.lastIndexOf(':') + 1)
    const key = normalizeForMatch(own)
    // A namespaced command wins over a bare one of the same name: the row sits
    // under a plugin's heading, so the plugin's command is the one it means.
    if (!byName.has(key) || full.includes(':')) byName.set(key, full)
  }
  return byName
})

// A group counts as installed when any of its commands is available. Before the
// session's command list has loaded (empty), assume installed so the useful
// command rows show rather than a flash of download cards.
function isInstalled(g: CleanupGroup): boolean {
  if (props.available.length === 0) return true
  return g.commands.some((c) => availableByName.value.has(normalizeForMatch(c.command)))
}

/**
 * A single row is runnable only when the session offers that exact command.
 *
 * A group counts as installed on ANY match, which is right — a plugin need not
 * ship every command the catalogue lists. But that also meant one real command
 * in a group made every row in it clickable, including rows naming a command the
 * plugin does not have. Those sent a slash command that could only answer
 * "Unknown command". The catalogue is hand-maintained, so it will drift again
 * whenever a plugin renames or withdraws a command; checking each row against
 * the session's own list is what stops that drift reaching a button.
 */
function isAvailable(c: CleanupCommand): boolean {
  if (props.available.length === 0) return true
  return availableByName.value.has(normalizeForMatch(c.command))
}

/**
 * A stack-specific plugin appears only once it is installed.
 *
 * Before this, the .NET toolkit was offered with a download button on every
 * project whatever its language. Installation is the signal that a developer
 * wants it, and it is a signal the app already has.
 */
const groups = computed(() => CLEANUP_GROUPS.filter((g) => !g.stackSpecific || isInstalled(g)))

/** Runs the name the SESSION knows, not the catalogue's short form: a bare
 *  `/code-review` reaches Claude Code's own built-in, while this row means the
 *  toolkit's. Falls back to the catalogue name before the list has loaded. */
function run(command: string): void {
  const resolved = availableByName.value.get(normalizeForMatch(command)) ?? command
  // The session's own names arrive already slashed (availableCommandNames maps
  // every one through slashName), while the catalogue's fallback is bare. Adding
  // one unconditionally sent "//de-sloppify" for every row the session had
  // actually reported — which is every row in real use, and none of them in the
  // tests, because those never set a command list and so always took the bare
  // fallback.
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
          <span class="cmd-run">{{ isAvailable(c) ? 'Run →' : 'Not available' }}</span>
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
          {{ installing ? 'Installing…' : '⤓ Download to project' }}
        </button>
      </div>
    </div>

    <!-- A cleanup command runs in the background session, so this tab had no way
         to show that anything was happening: the output was arriving in a
         session the developer never opens. -->
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
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
  text-align: left;
}

.cmd-row:hover:not(:disabled) {
  border-color: var(--green);
}

/* A row the session cannot run stays readable rather than hidden: the command is
   still worth knowing about, and hiding it would leave the group looking short
   with no reason given. The title attribute carries the reason. */
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
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
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
