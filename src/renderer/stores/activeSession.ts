// Event stream state for the selected session: ordered by seq (the only
// ordering key), in-place updates by event id, clean/raw view preference per
// session, and composer interaction (FR-014/016/019/020).
import { defineStore } from 'pinia'
import type { SessionEvent } from '@shared/domain'

interface ActiveSessionState {
  sessionId: string | null
  events: SessionEvent[]
  viewBySession: Record<string, 'clean' | 'raw'>
  defaultView: 'clean' | 'raw'
  /** Oldest loaded seq, for paging back through history. */
  oldestSeq: number | null
  hasMoreHistory: boolean
  focusEventId: string | null
  /** Subagent whose chat view is open (Task tool_use id), or null for the session. */
  selectedAgentId: string | null
}

const PAGE_SIZE = 300

export const useActiveSessionStore = defineStore('activeSession', {
  state: (): ActiveSessionState => ({
    sessionId: null,
    events: [],
    viewBySession: {},
    defaultView: 'clean',
    oldestSeq: null,
    hasMoreHistory: false,
    focusEventId: null,
    selectedAgentId: null,
  }),

  getters: {
    view(state): 'clean' | 'raw' {
      if (!state.sessionId) return state.defaultView
      return state.viewBySession[state.sessionId] ?? state.defaultView
    },
  },

  actions: {
    async open(sessionId: string | null): Promise<void> {
      this.sessionId = sessionId
      this.events = []
      this.oldestSeq = null
      this.hasMoreHistory = false
      this.selectedAgentId = null
      if (!sessionId) return
      const events = await window.switchboard.invoke('sessions.events', {
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
      const older = await window.switchboard.invoke('sessions.events', {
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
      const index = this.events.findIndex((e) => e.id === event.id)
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
    },

    setView(view: 'clean' | 'raw'): void {
      if (this.sessionId) this.viewBySession[this.sessionId] = view
      else this.defaultView = view
    },

    async send(text: string, agentId?: string): Promise<{ eventId: string; queued: boolean }> {
      if (!this.sessionId) throw new Error('No active session')
      return window.switchboard.invoke('sessions.send', { sessionId: this.sessionId, text, agentId })
    },

    /** Open (or close, with null) a subagent's chat view. */
    selectAgent(agentId: string | null): void {
      this.selectedAgentId = agentId
    },

    async answerQuestion(eventId: string, choice: string): Promise<void> {
      if (!this.sessionId) return
      await window.switchboard.invoke('sessions.answerQuestion', {
        sessionId: this.sessionId,
        eventId,
        choice,
      })
    },

    async interrupt(): Promise<{ stillQueued: number }> {
      if (!this.sessionId) return { stillQueued: 0 }
      return window.switchboard.invoke('sessions.interrupt', { sessionId: this.sessionId })
    },

    async stop(): Promise<void> {
      if (!this.sessionId) return
      await window.switchboard.invoke('sessions.stop', { sessionId: this.sessionId })
    },

    focusEvent(eventId: string): void {
      this.focusEventId = eventId
    },
  },
})
