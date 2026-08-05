// Event stream state for the selected session: ordered by seq (the only
// ordering key), in-place updates by event id, clean/raw view preference per
// session, and composer interaction (FR-014/016/019/020).
import { reactive } from 'vue'
import type { SessionEvent } from '@shared/domain'
import { invoke } from '@renderer/ipc'

const PAGE_SIZE = 300

/**
 * How many events of one session the renderer keeps in memory.
 *
 * The DOM was already bounded (SessionView renders at most 500 items and derives
 * from the last 1500 events), but THIS array was not: every event pushed during a
 * session stayed in it for as long as the view was open, payload text included. A
 * day on one long-running project therefore grew the renderer's heap without limit
 * — and on this machine the renderer competes for the same memory as the bypass
 * sandbox's virtual machine, so the app quietly holding hundreds of megabytes of
 * text nobody is looking at is what makes a container run out.
 *
 * 3000 is twice the derive window on purpose: SessionView's "show earlier" first
 * widens its own window over what the store holds, and only then pages back
 * through the database. Trimming at the derive window would make that first step
 * do nothing.
 *
 * Nothing is lost — every event is in SQLite, and trimming restores the
 * "show earlier" affordance so paging brings it back.
 *
 * ponytail: a flat count, not a byte budget. Payload sizes vary, but a count is
 * something the code can enforce for free; measure bytes only if a session with
 * enormous single payloads shows this is the wrong ceiling.
 */
const MAX_LIVE_EVENTS = 3000

const store = reactive({
  sessionId: null as string | null,
  events: [] as SessionEvent[],
  viewBySession: {} as Record<string, 'clean' | 'raw'>,
  defaultView: 'clean' as 'clean' | 'raw',
  /** Oldest loaded seq, for paging back through history. */
  oldestSeq: null as number | null,
  hasMoreHistory: false,
  focusEventId: null as string | null,
  /** Subagent whose chat view is open (Task tool_use id), or null for the session. */
  selectedAgentId: null as string | null,
  /** Text another component asks the composer to append (e.g. @path from a file drop). */
  composerInsert: null as string | null,
  /** Whether the combined Database MCP view is open (vs. the session view). */
  mcpOpen: false,

  /**
   * Deliberately a plain getter, not a `computed()`.
   *
   * The store rule exists because an uncached derivation that does real WORK
   * (projects.ts's nameCollisions rebuilt a Map and a Set) re-runs on every read.
   * This one is a null check and a single record lookup, read five times from
   * SessionView's template and never inside a v-for or a per-event derivation.
   * Making it a computed would mean splitting state out of this store and
   * rewriting all fifteen methods that use `this` — in the code that owns event
   * ordering, in-place updates and paging — to buy nothing measurable.
   */
  get view(): 'clean' | 'raw' {
    if (!this.sessionId) return this.defaultView
    return this.viewBySession[this.sessionId] ?? this.defaultView
  },

  async open(sessionId: string | null): Promise<void> {
    this.sessionId = sessionId
    this.events = []
    this.oldestSeq = null
    this.hasMoreHistory = false
    this.selectedAgentId = null
    if (!sessionId) return
    const events = await invoke('sessions.events', {
      sessionId,
      limit: PAGE_SIZE,
    })
    if (this.sessionId !== sessionId) return
    this.events = events
    this.oldestSeq = events.length > 0 ? events[0].seq : null
    this.hasMoreHistory = events.length >= PAGE_SIZE
  },

  async loadEarlier(): Promise<void> {
    if (!this.sessionId || this.oldestSeq === null) return
    const older = await invoke('sessions.events', {
      sessionId: this.sessionId,
      beforeSeq: this.oldestSeq,
      limit: PAGE_SIZE,
    })
    this.events = [...older, ...this.events]
    this.oldestSeq = this.events.length > 0 ? this.events[0].seq : null
    this.hasMoreHistory = older.length >= PAGE_SIZE
  },

  /** push.event: replace by id (in-place updates) or insert in seq order. */
  applyEventPush(event: SessionEvent): void {
    if (event.sessionId !== this.sessionId) return
    // Backwards, not forwards. Ids are unique so the result is identical, but the
    // events that get replaced in place are partials and tool pairs still being
    // streamed, which are always at the tail. Scanning from the front compared
    // against the whole session history on every push, at streaming rates.
    const index = this.events.findLastIndex((e) => e.id === event.id)
    if (index !== -1) {
      this.events[index] = event
      return
    }
    const last = this.events[this.events.length - 1]
    if (!last || event.seq > last.seq) {
      this.events.push(event)
    } else {
      const at = this.events.findIndex((e) => e.seq > event.seq)
      this.events.splice(at === -1 ? this.events.length : at, 0, event)
    }
    this.trimHead()
  },

  /**
   * Drop the oldest events once the live tail passes its cap.
   *
   * Only ever called from a push: `loadEarlier` grows the array because the
   * developer asked it to, and trimming what they just asked for would make the
   * button appear to do nothing. Paging state is updated with it, so the view
   * offers "show earlier" again for exactly what was dropped.
   */
  trimHead(): void {
    const excess = this.events.length - MAX_LIVE_EVENTS
    if (excess <= 0) return
    this.events.splice(0, excess)
    this.oldestSeq = this.events[0]?.seq ?? null
    this.hasMoreHistory = true
  },

  setView(view: 'clean' | 'raw'): void {
    if (this.sessionId) this.viewBySession[this.sessionId] = view
    else this.defaultView = view
  },

  async send(text: string, agentId?: string): Promise<{ eventId: string; queued: boolean }> {
    if (!this.sessionId) throw new Error('No active session')
    return invoke('sessions.send', { sessionId: this.sessionId, text, agentId })
  },

  /** Open (or close, with null) a subagent's chat view. */
  selectAgent(agentId: string | null): void {
    this.selectedAgentId = agentId
  },

  /** Open or close the combined Database MCP view. */
  openMcp(open: boolean): void {
    this.mcpOpen = open
    if (open) this.selectedAgentId = null
  },

  /**
   * Reword a queued composer message, or withdraw it with empty text.
   *
   * Deliberately not optimistic. The turn can finish while the editor is open, in
   * which case the main process refuses and the push that already delivered the
   * message stands — showing the new text first and reverting it would flash a
   * change that never happened.
   */
  async editQueued(eventId: string, text: string): Promise<void> {
    if (!this.sessionId) return
    await invoke('sessions.editQueued', { sessionId: this.sessionId, eventId, text })
  },

  async answerQuestion(eventId: string, choice: string): Promise<void> {
    if (!this.sessionId) return
    await invoke('sessions.answerQuestion', {
      sessionId: this.sessionId,
      eventId,
      choice,
    })
  },

  async interrupt(): Promise<{ stillQueued: number }> {
    if (!this.sessionId) return { stillQueued: 0 }
    return invoke('sessions.interrupt', { sessionId: this.sessionId })
  },

  /** Move the live session into or out of plan mode. The header reads the mode
   *  the CLI reports back, not this request, so it can never over-claim. */
  async setPlanMode(enabled: boolean): Promise<void> {
    if (!this.sessionId) return
    await invoke('sessions.setPlanMode', { sessionId: this.sessionId, enabled })
  },

  /** End the session for good (resumable later); queued sends survive as drafts. */
  async stop(): Promise<void> {
    if (!this.sessionId) return
    await invoke('sessions.stop', { sessionId: this.sessionId })
  },

  focusEvent(eventId: string): void {
    this.focusEventId = eventId
  },

  /** Clear the "scroll to this event" signal once the view has consumed it. */
  clearFocusEvent(): void {
    this.focusEventId = null
  },

  /** Ask the composer to append text (file drops from the sidebar). */
  requestComposerInsert(text: string): void {
    this.composerInsert = text
  },

  /** Clear the pending composer insert once the composer has taken it. */
  clearComposerInsert(): void {
    this.composerInsert = null
  },
})

export const useActiveSessionStore = (): typeof store => store
