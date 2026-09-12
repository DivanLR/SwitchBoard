import { reactive } from 'vue'
import type { SessionEvent } from '@shared/domain'
import { invoke } from '@renderer/ipc'

const PAGE_SIZE = 300

const MAX_LIVE_EVENTS = 3000

const MAX_TAIL_EVENTS = 150

const store = reactive({
  sessionId: null as string | null,
  events: [] as SessionEvent[],
  tails: {} as Record<string, SessionEvent[]>,
  viewBySession: {} as Record<string, 'clean' | 'raw'>,
  defaultView: 'clean' as 'clean' | 'raw',
  oldestSeq: null as number | null,
  hasMoreHistory: false,
  focusEventId: null as string | null,
  selectedAgentId: null as string | null,
  composerInsert: null as string | null,
  mcpOpen: false,
  fullScreenSection: null as string | null,

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
    const sessionId = this.sessionId
    const older = await invoke('sessions.events', {
      sessionId,
      beforeSeq: this.oldestSeq,
      limit: PAGE_SIZE,
    })
    if (this.sessionId !== sessionId) return
    this.events = [...older, ...this.events]
    this.oldestSeq = this.events.length > 0 ? this.events[0].seq : null
    this.hasMoreHistory = older.length >= PAGE_SIZE
  },

  applyEventPush(event: SessionEvent): void {
    this.appendTail(event)
    if (event.sessionId !== this.sessionId) return
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

  async watchTail(sessionId: string): Promise<void> {
    if (!this.tails[sessionId]) this.tails[sessionId] = []
    try {
      const events = await invoke('sessions.events', { sessionId, limit: MAX_TAIL_EVENTS })
      if ((this.tails[sessionId]?.length ?? 0) === 0) this.tails[sessionId] = events
    } catch {
    }
  },

  unwatchTail(sessionId: string): void {
    delete this.tails[sessionId]
  },

  appendTail(event: SessionEvent): void {
    const tail = this.tails[event.sessionId]
    if (!tail) return
    const index = tail.findLastIndex((e) => e.id === event.id)
    if (index !== -1) {
      tail[index] = event
      return
    }
    tail.push(event)
    if (tail.length > MAX_TAIL_EVENTS) tail.splice(0, tail.length - MAX_TAIL_EVENTS)
  },

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

  async sendTo(sessionId: string, text: string): Promise<void> {
    await invoke('sessions.send', { sessionId, text })
  },

  selectAgent(agentId: string | null): void {
    this.selectedAgentId = agentId
  },

  openMcp(open: boolean): void {
    this.mcpOpen = open
    if (open) this.selectedAgentId = null
  },

  setFullScreen(section: string | null): void {
    this.fullScreenSection = section
  },

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

  async clearBackgroundTasks(): Promise<void> {
    if (!this.sessionId) return
    await invoke('sessions.clearBackgroundTasks', { sessionId: this.sessionId })
  },

  async setPlanMode(enabled: boolean): Promise<void> {
    if (!this.sessionId) return
    await invoke('sessions.setPlanMode', { sessionId: this.sessionId, enabled })
  },

  async stop(): Promise<void> {
    if (!this.sessionId) return
    await invoke('sessions.stop', { sessionId: this.sessionId })
  },

  focusEvent(eventId: string): void {
    this.focusEventId = eventId
  },

  clearFocusEvent(): void {
    this.focusEventId = null
  },

  requestComposerInsert(text: string): void {
    this.composerInsert = text
  },

  clearComposerInsert(): void {
    this.composerInsert = null
  },
})

export const useActiveSessionStore = (): typeof store => store
