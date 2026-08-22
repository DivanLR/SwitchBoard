// Transient messages: the thing that happened, said once, without taking a
// decision away from anyone.
//
// New on 2026-08-21. Before this the app had exactly two ways to tell a
// developer something: a banner that stays until dismissed (the updater), and an
// inline error beside the control that failed. Both are right for what they do
// and neither fits "the import worked" or "that session is now called release
// smoke" — outcomes worth confirming and not worth a permanent row. Those either
// went unsaid or turned into a banner that outlived its own news.
//
// NOT for anything blocking. A permission request goes to the inbox, an error a
// developer must act on stays beside the control that produced it, and a session
// crash keeps its banner. A toast that can be missed must never be the only
// place a decision is offered.
import { reactive } from 'vue'

/** Maps onto this world's colour roles, not the reference's four cyan-keyed
 *  types: green is action succeeded, red is a real failure, amber is attention
 *  owed, and info is the identity teal that carries no tolerance meaning. */
export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  message?: string
  /** Milliseconds on screen. 0 keeps it until the developer dismisses it. */
  duration: number
}

/** The reference's ceiling, and a sensible one: a sixth toast is a log, and a
 *  log is not what a corner of the screen is for. */
const MAX_VISIBLE = 5
const DEFAULT_DURATION = 5000

let nextId = 1

const state = reactive({
  items: [] as Toast[],
})

/**
 * Timers live outside the reactive state on purpose.
 *
 * A timer handle is machinery, not something a view renders, and putting one in
 * a `reactive()` object means every tick of bookkeeping is a dependency
 * notification. The host component owns pausing them on hover; this store owns
 * the list.
 */
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function clearTimer(id: number): void {
  const handle = timers.get(id)
  if (handle !== undefined) {
    clearTimeout(handle)
    timers.delete(id)
  }
}

const store = reactive({
  ...{ items: state.items },

  /** Show one. Returns its id so a caller can dismiss it early. */
  show(kind: ToastKind, title: string, message?: string, duration = DEFAULT_DURATION): number {
    const id = nextId++
    state.items.push({ id, kind, title, message, duration })
    // Oldest first: the newest message is the one the developer is waiting for,
    // so the queue sheds from the top rather than refusing to add.
    while (state.items.length > MAX_VISIBLE) {
      const dropped = state.items.shift()
      if (dropped) clearTimer(dropped.id)
    }
    if (duration > 0) {
      timers.set(
        id,
        setTimeout(() => store.dismiss(id), duration),
      )
    }
    return id
  },

  success(title: string, message?: string): number {
    return store.show('success', title, message)
  },
  error(title: string, message?: string): number {
    // Longer, and never silent: a failure the developer blinked past is a
    // failure they will report as "it just did nothing".
    return store.show('error', title, message, 8000)
  },
  info(title: string, message?: string): number {
    return store.show('info', title, message)
  },
  warning(title: string, message?: string): number {
    return store.show('warning', title, message)
  },

  dismiss(id: number): void {
    clearTimer(id)
    const at = state.items.findIndex((t) => t.id === id)
    if (at >= 0) state.items.splice(at, 1)
  },

  /** Hover pauses the countdown, which is the reference's rule and the reason a
   *  developer can actually finish reading a long message. */
  pause(id: number): void {
    clearTimer(id)
  },

  /** Resume from the top of the toast's own duration rather than the remainder:
   *  the developer just stopped reading it, so it gets a fresh look-away window.
   *  Tracking the remaining milliseconds is more code for a worse result. */
  resume(id: number): void {
    const toast = state.items.find((t) => t.id === id)
    if (!toast || toast.duration <= 0 || timers.has(id)) return
    timers.set(
      id,
      setTimeout(() => store.dismiss(id), toast.duration),
    )
  },
})

export const useToastsStore = (): typeof store => store
