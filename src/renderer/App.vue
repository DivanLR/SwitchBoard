<script setup lang="ts">
// Application shell — 1:1 with the Switchboard design reference: sidebar
// (252px) | session stream | inbox panel (332px, always visible). Push
// subscriptions and notification click routing (FR-013a) live here.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useProjectsStore } from '@renderer/stores/projects'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useInboxStore } from '@renderer/stores/inbox'
import { useQueueStore } from '@renderer/stores/queue'
import { useDiagramsStore } from '@renderer/stores/diagrams'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'
import Sidebar from '@renderer/components/Sidebar.vue'
import StatusBar from '@renderer/components/StatusBar.vue'
import SessionView from '@renderer/views/SessionView.vue'
import McpView from '@renderer/views/McpView.vue'
import InboxView from '@renderer/views/InboxView.vue'
import ProjectRegistration from '@renderer/components/ProjectRegistration.vue'
import SettingsPanel from '@renderer/components/SettingsPanel.vue'
import GlobalSpinner from '@renderer/components/GlobalSpinner.vue'
import SessionWaitOverlay from '@renderer/components/SessionWaitOverlay.vue'
import Icon from '@renderer/components/Icon.vue'

const projects = useProjectsStore()
const active = useActiveSessionStore()
const inbox = useInboxStore()
const queue = useQueueStore()
const diagrams = useDiagramsStore()
const settingsStore = useSettingsStore()
const updates = useUpdatesStore()

const showRegistration = ref(false)
const showSettings = ref(false)
const settingsTab = ref<'models' | 'proj' | 'allowed' | 'term' | 'gen'>('models')

function openSettings(tab: 'models' | 'proj' | 'allowed' | 'term' | 'gen' = 'models'): void {
  settingsTab.value = tab
  showSettings.value = true
}
const bridgeMissing = ref(false)
const updateDismissed = ref(false)

// The inbox panel is drag-resizable; its width persists across launches.
// localStorage, not the settings store: this is renderer chrome with no
// main-process consumer, and reading it back is synchronous at module init —
// the settings store's load() is an await behind an IPC round trip, and this
// value is needed for the very first layout, before that reply could ever land.
const INBOX_MIN = 280
const INBOX_MAX = 680
function clampInbox(w: number): number {
  return Math.min(INBOX_MAX, Math.max(INBOX_MIN, w))
}
const inboxWidth = ref(clampInbox(Number(localStorage.getItem('sb-inbox-w')) || 332))

// The inbox can be collapsed to reclaim width; a glowing badge in the top-right
// reopens it and shows the pending count. Persisted the same way and for the
// same reason as inboxWidth above: renderer-only layout state, needed before
// the settings store has anything to say.
const inboxCollapsed = ref(localStorage.getItem('sb-inbox-collapsed') === '1')
function setInboxCollapsed(v: boolean): void {
  inboxCollapsed.value = v
  localStorage.setItem('sb-inbox-collapsed', v ? '1' : '0')
}

// Tracks the live drag's own teardown, so onUnmounted (below) can run the exact
// same cleanup a mouseup would have — remove both window listeners and restore
// the body's userSelect/cursor — if the component goes away mid-drag instead.
// Nulled out once a drag finishes normally, so an unmount afterwards has
// nothing left to tear down.
let stopInboxResize: (() => void) | null = null

function startInboxResize(event: MouseEvent): void {
  event.preventDefault()
  const startX = event.clientX
  const startW = inboxWidth.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  const onMove = (e: MouseEvent): void => {
    // The handle sits on the inbox's left edge, so dragging left widens it.
    inboxWidth.value = clampInbox(startW - (e.clientX - startX))
  }
  const onUp = (): void => {
    stopInboxResize = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    localStorage.setItem('sb-inbox-w', String(inboxWidth.value))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  // Mousemove/mouseup are registered on window rather than the handle, so they
  // survive the pointer leaving the 6px strip — but that also means they only
  // ever got removed by mouseup firing. Unmounting mid-drag (a project switch,
  // say, while the mouse is still down) used to leak both listeners onto window
  // for the rest of the app's life, with onMove going on to write inboxWidth
  // into a ref whose owning component was already gone, and the body left
  // stuck in userSelect: none / cursor: col-resize with no drag left to end it.
  stopInboxResize = onUp
}

const unsubscribers: (() => void)[] = []

onMounted(async () => {
  if (!window.switchboard) {
    bridgeMissing.value = true
    return
  }

  unsubscribers.push(
    window.switchboard.on('push.event', (event) => active.applyEventPush(event)),
    window.switchboard.on('push.sessionStatus', (push) => projects.applyStatusPush(push)),
    window.switchboard.on('push.counters', (counters) => projects.setCounters(counters)),
    window.switchboard.on('push.inboxChanged', (push) => inbox.applyInboxPush(push)),
    window.switchboard.on('push.queueChanged', (push) => queue.applyQueuePush(push)),
    // A diagram appears the moment its session stops drawing, rather than on the
    // next tick of the store's own poll.
    window.switchboard.on('push.diagramsChanged', (push) =>
      diagrams.applyChanged(push.projectId, push.entries),
    ),
    window.switchboard.on('push.focusRequest', (push) => {
      if (push.target === 'inbox') {
        inbox.focusRequest(push.requestId)
      } else {
        const project = projects.items.find((p) => p.session?.id === push.sessionId)
        if (project) projects.select(project.id)
        if (push.eventId) active.focusEvent(push.eventId)
      }
    }),
    window.switchboard.on('push.updateStatus', (status) => {
      updates.apply(status)
      if (status.state === 'available') updateDismissed.value = false
    }),
  )

  await settingsStore.load()
  active.defaultView = settingsStore.settings?.defaultView ?? 'clean'
  await Promise.all([projects.refresh(), inbox.refresh()])
})

onUnmounted(() => {
  for (const unsubscribe of unsubscribers) unsubscribe()
  // See the note on stopInboxResize above: a no-op unless a drag is actually
  // in flight when this component goes away.
  stopInboxResize?.()
})

const selectedProject = computed(() => projects.selected)
// The Database MCP view is global (bound to the reserved project). Its session
// outlives view switches; selecting a project just closes the view (see
// projects.select → openMcp(null)) so the chat swaps like any project switch.
const dbProject = computed(() => projects.dbProject)
</script>

<template>
  <div v-if="bridgeMissing" class="bridge-missing">
    <div class="mono" style="font-size: var(--fs-head); font-weight: var(--w-em)">
      <span style="color: var(--green)"><Icon name="grid" :size="18" /></span> switchboard
    </div>
    <p class="dim">
      The IPC bridge is not available. Start the application with <code>npm run dev</code>.
    </p>
  </div>

  <!-- The direction contract for the world this app is built in lives at the top
       of <body> in index.html, so it survives the production build. It is not
       duplicated here: the previous copy outlived its own world and went on
       describing the engraved-score metaphor, in the shell template, after the
       app had moved to the deployable-sheet look. One contract, one place. -->
  <div v-else class="shell">
    <div
      v-if="updates.active && !updateDismissed"
      class="update-banner"
      data-testid="update-banner"
    >
      <span class="ub-dot"></span>
      <span class="ub-text">
        <template v-if="updates.downloading">
          Downloading update{{ updates.status.version ? ` (${updates.status.version})` : '' }}… {{ updates.percent }}%
        </template>
        <template v-else-if="updates.ready">
          Update downloaded — the installer is opening. The app will close.
        </template>
        <!-- A failed update said nothing at all before this: the banner simply
             disappeared and the app stayed on the old version. -->
        <template v-else-if="updates.failed">
          The update could not be installed{{
            updates.status.message ? ` — ${updates.status.message}` : ''
          }}. You are still on the current version; try again later or download it
          from the releases page.
        </template>
        <template v-else>
          A new version{{ updates.status.version ? ` (${updates.status.version})` : '' }} is available.
        </template>
      </span>
      <button
        v-if="updates.available"
        class="ub-install"
        data-testid="update-banner-install"
        @click="updates.install()"
      >
        download &amp; install
      </button>
      <button
        v-if="!updates.ready"
        class="ub-dismiss"
        data-testid="update-banner-dismiss"
        aria-label="Dismiss"
        @click="updateDismissed = true"
      >
        <Icon name="close" />
      </button>
    </div>
    <div class="panes" :style="{ '--inbox-w': `${inboxWidth}px` }">
      <Sidebar
        @add-project="showRegistration = true"
        @open-settings="openSettings()"
      />

      <main class="main">
        <McpView
          v-if="dbProject && active.mcpOpen"
          :project="dbProject"
        />
        <SessionView v-else-if="selectedProject" :project="selectedProject" />
        <div v-else class="no-project">
          <div class="mono faint" style="font-size: var(--fs-ui)">no project selected</div>
          <button class="btn-solid" data-testid="add-project-empty" @click="showRegistration = true">
            add a project
          </button>
        </div>
      </main>

      <template v-if="!inboxCollapsed">
        <div
          class="inbox-resize"
          data-testid="inbox-resize"
          title="Drag to resize the inbox"
          @mousedown="startInboxResize"
        ></div>
        <InboxView @collapse="setInboxCollapsed(true)" />
      </template>

      <!-- Collapsed: a thin right rail. The glowing count at its top reopens the
           inbox and makes pending items impossible to miss. -->
      <div v-if="inboxCollapsed" class="inbox-rail" data-testid="inbox-rail">
        <button
          class="inbox-peek"
          :class="{ glow: inbox.pendingCount > 0 }"
          data-testid="inbox-peek"
          :title="inbox.pendingCount > 0 ? `${inbox.pendingCount} waiting — open inbox` : 'Open inbox'"
          @click="setInboxCollapsed(false)"
        >
          <span v-if="inbox.pendingCount > 0" data-testid="inbox-peek-count">{{ inbox.pendingCount }}</span>
          <span v-else class="inbox-peek-icon"><Icon name="chevron-left" :size="12" /></span>
        </button>
        <span class="inbox-rail-label mono">INBOX</span>
      </div>
    </div>

    <!-- The board's own readings, on one rule under every pane. They were a card
         in the sidebar footer; a control room keeps its gauges along the bottom
         edge, where they are always legible and never in the way. -->
    <StatusBar />

    <ProjectRegistration v-if="showRegistration" @close="showRegistration = false" />
    <SettingsPanel v-if="showSettings" :initial-tab="settingsTab" @close="showSettings = false" />

    <!-- Starting a session takes the whole window: it is not a background task
         the developer can work around, and a bypass start builds a container
         the first time, which runs to minutes. The matching screen for ending a
         session is the same component. -->
    <SessionWaitOverlay
      v-if="projects.starting"
      testid="session-start-overlay"
      title="Starting session…"
      sub="First bypass start builds its container — this can take a few minutes."
    />
  </div>

  <!-- Global loading spinner — shows while any IPC call is in flight. -->
  <GlobalSpinner />
</template>

<style scoped>
.shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  /* Design's outer wrapper is transparent so the body's glow gradient
     shows through the glass sidebar/panels; the main pane stays opaque
     (see .main below) and covers it where the design does too. */
  background: transparent;
  overflow: auto;
}

.update-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: color-mix(in srgb, var(--green) 8%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--green) 30%, transparent);
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.ub-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--rp);
  background: var(--green);
  animation: sbFade 2.2s ease infinite;
}

.ub-text {
  flex: 1;
}

.ub-install {
  background: var(--green);
  color: var(--green-ink);
  font-weight: var(--w-em);
  font-size: var(--fs-meta);
  font-family: var(--sans);
  padding: 4px 12px;
  border-radius: var(--rc);
  cursor: pointer;
}

.ub-dismiss {
  color: var(--text-tab);
  font-size: var(--fs-ui);
  padding: 2px 6px;
}

.ub-dismiss:hover {
  color: var(--text-body);
}

.panes {
  display: flex;
  flex: 1;
  /* Keep these two in step with BrowserWindow's minWidth/minHeight in
     src/main/index.ts. CSS cannot import the constant, so the pairing is stated in
     both places: an OS floor below this one clips the panes with no scrollbar. */
  min-width: 1080px;
  min-height: 560px;
  overflow: hidden;
}

/* Collapsed inbox: a thin rail on the right with the reopen control at its top. */
.inbox-rail {
  flex-shrink: 0;
  width: 44px;
  min-width: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  box-shadow: var(--hairline-shine);
}

.inbox-peek {
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--rp);
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-tab);
  font-family: var(--mono);
  font-size: var(--fs-ui);
  cursor: pointer;
}

.inbox-peek:hover {
  color: var(--text-strong);
  border-color: var(--border-seg);
}

/* Pending items: amber pill that pulses so it draws the eye. */
.inbox-peek.glow {
  color: var(--amber-ink);
  background: var(--amber);
  border-color: var(--amber);
  font-weight: var(--w-em);
  animation: inboxPeekGlow 1.8s ease-in-out infinite;
}

/* Vertical "INBOX" label down the rail. */
.inbox-rail-label {
  writing-mode: vertical-rl;
  font-size: var(--fs-micro);
  letter-spacing: 0.18em;
  color: var(--text-faint);
  user-select: none;
}

@keyframes inboxPeekGlow {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--amber) 55%, transparent);
  }
  50% {
    box-shadow: 0 0 10px 3px color-mix(in srgb, var(--amber) 75%, transparent);
  }
}

/* The centre pane carries the world's ground, and in THE SIXTEEN-COLOUR FIELD that
   ground is flat ink. The 60-degree crease lattice that used to rule this pane was
   the deployable sheet's signature; it is removed outright rather than faded to a
   transparent no-op, because a stylesheet that paints nothing through two live
   gradients is a motif nobody deleted rather than a decision anybody made.
   This world's texture is an ordered dither, and it belongs to the panels and bars
   the idiom layer draws, never to the open field: the source dithers a gradient it
   cannot render, not the ground it can. */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* No crease in light mode. The lattice is the scored-sheet world's signature and
   light mode no longer belongs to it: the Cornflower direction asks for a flat,
   calm canvas, and this is the pane with the most empty ground to be calm on.
   Setting --crease transparent leaves the gradients in place but paints nothing,
   so the shorthand above stays the single declaration of this pane's background.
   See the matching note on html.sb-light body in styles.css. */
/* The light-mode crease override is gone with the crease itself. It existed to
   switch the lattice off on the Cornflower ground; there is no lattice in either
   theme now, and the two grounds are the same world's two inks. */

/* Drag handle on the inbox's left edge (design seam sits on the inbox border). */
.inbox-resize {
  position: relative;
  flex-shrink: 0;
  width: 6px;
  margin-right: -6px;
  z-index: 2;
  cursor: col-resize;
  background: transparent;
}

/* A grip, because a handle nobody can see is a feature nobody has. This one was
   fully working and drag-persisted, and was still reported as missing: it was
   6px of transparency that only appeared once the pointer was already on it.
   Three short strokes at the vertical centre, quiet enough to ignore and
   specific enough to aim at. */
.inbox-resize::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 2px;
  height: 22px;
  transform: translate(-50%, -50%);
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  opacity: 0.7;
  transition: opacity 120ms ease;
}

.inbox-resize:hover {
  background: var(--border);
}

.inbox-resize:hover::after {
  opacity: 0;
}

.no-project {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.bridge-missing {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
</style>
