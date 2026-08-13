<script setup lang="ts">
// Diagrams section: type what you want, the project's session hands it to the
// diagram-design plugin, and the plugin writes a standalone HTML file into the
// project's own docs/diagrams. This view only asks and lists — the plugin has
// no slash command, so unlike Cleanup there is nothing here to "run" once it
// is installed, only the one generate box and the folder's contents.
import { computed, onMounted, ref, watch } from 'vue'
import { DIAGRAM_PLUGIN, DIAGRAMS_DIR } from '@shared/diagram'
import { relativeTime } from '@renderer/relative-time'
import { normalizeForMatch } from '@renderer/composables/useCommandSuggestions'
import { useDiagramsStore } from '@renderer/stores/diagrams'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'

const props = defineProps<{
  projectId: string
  available: string[]
  /** True while this plugin's host-side install is running. */
  installing?: boolean
  /** Why the install failed, in the CLI's own words. Null when it has not. */
  installError?: string | null
}>()

const emit = defineEmits<{ (e: 'install'): void }>()

const diagrams = useDiagramsStore()

onMounted(() => void diagrams.load(props.projectId))
watch(() => props.projectId, (id) => void diagrams.load(id))

// Installed when the plugin's probe command shows up in the session's own
// command list. Before that list has loaded (empty), assume installed rather
// than flashing a download card that a moment later turns out to be wrong —
// the same rule CleanupView applies per group.
const installed = computed(() => {
  if (props.available.length === 0) return true
  const key = normalizeForMatch(DIAGRAM_PLUGIN.probeCommand)
  return props.available.some((c) => normalizeForMatch(c) === key)
})

const description = ref('')

async function generate(): Promise<void> {
  const text = description.value.trim()
  if (!text) return
  // The drawing happens in a background session and the finished file turns up
  // in the list below, so there is nothing to switch to and nothing to watch.
  if (await diagrams.generate(props.projectId, text)) description.value = ''
}

/** Shown only while it belongs to the project on screen. */
const pending = computed(() =>
  diagrams.pending?.projectId === props.projectId ? diagrams.pending : null,
)

// Newest first: what was just asked for is what a developer wants to check on.
const list = computed(() =>
  [...diagrams.forProject(props.projectId)].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
)

const ago = (iso: string): string => relativeTime(iso, Date.now())

/** The diagram in the preview pane, and its HTML once read. */
const selected = computed(() =>
  diagrams.selected?.projectId === props.projectId ? diagrams.selected.file : null,
)
const selectedHtml = computed(() => (selected.value ? diagrams.html[selected.value] : undefined))
const selectedEntry = computed(() => list.value.find((d) => d.file === selected.value) ?? null)

// Opening the tab on a project that already has diagrams shows one rather than an
// empty pane. The newest is the one most likely to be the reason you came here.
watch(
  list,
  (entries) => {
    if (selected.value || entries.length === 0) return
    void diagrams.select(props.projectId, entries[0].file)
  },
  { immediate: true },
)
</script>

<template>
  <div class="diagrams" data-testid="diagrams-view">
    <div class="intro">
      Describe a diagram and the project's session will draw it with the diagram-design plugin, as a
      standalone HTML file in <span class="mono">{{ DIAGRAMS_DIR }}</span
      >.
    </div>

    <div v-if="!installed" class="install-card">
      <div class="install-text">
        <div class="install-title">
          diagram-design is not installed in this project — add it to generate diagrams
        </div>
        <div class="install-cmds mono">{{ DIAGRAM_PLUGIN.marketplace }} · {{ DIAGRAM_PLUGIN.pkg }}</div>
        <!-- Named, not swallowed: this install used to fail silently, so the one
             thing it must never do again is look identical to doing nothing. -->
        <div v-if="installError" class="install-error" data-testid="diagrams-install-error">
          {{ props.installError }}
        </div>
      </div>
      <button
        class="install-btn"
        data-testid="diagrams-install"
        :disabled="props.installing"
        @click="emit('install')"
      >
        {{ props.installing ? 'Installing…' : '⤓ Download to project' }}
      </button>
    </div>

    <div class="add">
      <input
        v-model="description"
        class="in"
        data-testid="diagram-input"
        placeholder="What should the diagram show — e.g. the auth flow from login to session refresh"
        :disabled="diagrams.generating"
        @keydown.enter="generate()"
      />
      <button
        class="add-btn"
        data-testid="diagram-generate"
        :disabled="diagrams.generating || !description.trim()"
        @click="generate()"
      >
        {{ diagrams.generating ? 'Asking…' : '✎ Generate' }}
      </button>
    </div>
    <div v-if="diagrams.error" class="err" data-testid="diagram-error">{{ diagrams.error }}</div>

    <!-- The row for a diagram that has been asked for and is not on disk yet. It
         names the file the app already chose, so the wait has something to point
         at rather than an empty list for a minute. -->
    <div
      v-if="pending"
      class="row pending"
      data-testid="diagram-pending"
      :aria-busy="true"
    >
      <div class="row-head">
        <span class="file mono">{{ pending.file }}</span>
        <span class="when mono">drawing…</span>
      </div>
      <div class="desc">{{ pending.description }}</div>
      <div class="row-meta">
        <span class="chip mono">running in the background</span>
      </div>
      <!-- The session drawing it is one the developer never opens, so without
           this the wait is a minute of a static word. -->
      <MiniTerminal :session-id="pending.sessionId" label="drawing" />
    </div>

    <div v-if="list.length === 0 && !pending" class="empty" data-testid="diagrams-empty">
      No diagrams yet. Generated diagrams are written to <span class="mono">{{ DIAGRAMS_DIR }}</span> in
      this project.
    </div>

    <!-- Two panes: what you have drawn, and the one you are looking at. The list
         is narrow on purpose — it is a way back to a diagram, not a report about
         one, so the detail sits under the picture instead of in every row. -->
    <div v-if="list.length > 0" class="split">
      <div class="past" data-testid="diagram-list">
        <button
          v-for="d in list"
          :key="d.file"
          type="button"
          class="past-row"
          :class="{ sel: d.file === selected }"
          :data-testid="`diagram-row-${d.file}`"
          :title="`${d.file} — double-click to open in your browser`"
          @click="diagrams.select(projectId, d.file)"
          @dblclick="diagrams.open(projectId, d.file)"
        >
          <span class="past-name mono">{{ d.file.replace(/\.html$/, '') }}</span>
          <span class="past-when mono">{{ ago(d.modifiedAt) }}</span>
        </button>
      </div>

      <div class="view">
        <div class="view-head">
          <span class="file mono">{{ selectedEntry?.file ?? '—' }}</span>
          <span class="spacer"></span>
          <span v-if="selectedEntry?.sessionId" class="chip mono" :title="selectedEntry.sessionId">
            session {{ selectedEntry.sessionId.slice(0, 8) }}
          </span>
          <button
            v-if="selected"
            class="act"
            :data-testid="`diagram-open-${selected}`"
            @click="diagrams.open(projectId, selected)"
          >
            ↗ Open in browser
          </button>
        </div>
        <div v-if="selectedEntry?.description" class="desc">{{ selectedEntry.description }}</div>
        <!-- The diagram is HTML this app asked a model to write into the repo. It
             renders with scripts refused twice over: the frame carries no
             allow-scripts, and the app's own CSP (script-src 'self') applies to
             srcdoc content. A diagram that wanted to run code renders as the
             picture it is. Never add allow-scripts here. -->
        <iframe
          v-if="selectedHtml !== undefined"
          class="frame"
          data-testid="diagram-frame"
          sandbox=""
          referrerpolicy="no-referrer"
          :title="selectedEntry?.file ?? 'diagram'"
          :srcdoc="selectedHtml"
        ></iframe>
        <div v-else class="frame-wait mono">reading…</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diagrams {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 52px;
}

.intro {
  max-width: 840px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-mid);
  margin-bottom: 16px;
  text-wrap: pretty;
}

.install-card {
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: 840px;
  padding: 13px 15px;
  margin-bottom: 16px;
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

.install-cmds {
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
  font-weight: 500;
  font-size: var(--fs-meta);
  padding: 8px 15px;
  border-radius: var(--rc);
  cursor: pointer;
  user-select: none;
  box-shadow: var(--green-glow);
}

.install-btn:hover {
  background: var(--green-hover);
}

.add {
  display: flex;
  gap: 8px;
  max-width: 840px;
  margin-bottom: 8px;
}

.in {
  flex: 1;
  min-width: 0;
  padding: 8px 11px;
  font-size: var(--fs-ui);
  color: var(--text-body);
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.in:focus {
  outline: none;
  border-color: var(--green);
}

.in:disabled {
  opacity: 0.6;
}

.add-btn {
  flex-shrink: 0;
  padding: 8px 15px;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--green-ink);
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
  border-radius: var(--rc);
  box-shadow: var(--green-glow);
  cursor: pointer;
  white-space: nowrap;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: default;
  box-shadow: none;
}

.err {
  max-width: 840px;
  margin-bottom: 8px;
  font-size: var(--fs-meta);
  color: var(--red);
}

/* Sits inside the install card rather than beside it: the reason an install
   failed belongs with the thing that failed, not in the page's error slot. */
.install-error {
  margin-top: 6px;
  font-size: var(--fs-meta);
  color: var(--red);
}

.empty {
  max-width: 840px;
  font-size: var(--fs-ui);
  color: var(--text-faint);
  text-wrap: pretty;
}

.row {
  max-width: 840px;
  padding: 11px 13px;
  margin-bottom: 9px;
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

/* On its way: the same row, quieter, so its arrival is a change of state
   rather than a new thing appearing. */
.row.pending {
  border-style: dashed;
  opacity: 0.8;
}

/* Same rationale as the split comment above: a narrow way back, not a report. */
.split {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  min-height: 0;
}

.past {
  flex-shrink: 0;
  width: 210px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 70vh;
  overflow-y: auto;
}

.past-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 9px;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--rc);
  cursor: pointer;
}

.past-row:hover {
  background: var(--bg-hover);
}

.past-row.sel {
  background: var(--bg-active);
}

.past-name {
  font-size: var(--fs-meta);
  color: var(--text-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.past-row.sel .past-name {
  color: var(--green);
}

.past-when {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.view {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.view-head {
  display: flex;
  align-items: center;
  gap: 9px;
}

/* White ground under the frame whatever the theme: the diagram is a document
   with its own page colour, and letting the carbon sheet show through its
   margins would read as part of the drawing. The token is theme-invariant by
   design — see --diagram-page in styles.css. */
.frame {
  width: 100%;
  height: 62vh;
  background: var(--diagram-page);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.frame-wait {
  height: 62vh;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-meta);
  color: var(--text-faint);
  border: 1px dashed var(--border-soft);
  border-radius: var(--rc);
}

.row-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.file {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.when {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.desc {
  margin-top: 5px;
  font-size: var(--fs-meta);
  color: var(--text-mid);
  line-height: 1.5;
  text-wrap: pretty;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 8px;
}

.chip {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  border-radius: var(--rp);
  padding: 1px 9px;
  white-space: nowrap;
  color: var(--text-faint);
  border: 1px solid var(--border-strong);
}

.spacer {
  flex: 1;
}

.act {
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: var(--fs-meta);
  color: var(--text-body);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  cursor: pointer;
}

.act:hover {
  border-color: var(--green);
}
</style>
