import { reactive } from 'vue'

type ToastKind = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: number
  kind: ToastKind
  title: string
  message?: string
  duration: number
}

const MAX_VISIBLE = 5
const DEFAULT_DURATION = 5000

let nextId = 1

const state = reactive({
  items: [] as Toast[],
})

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

  show(kind: ToastKind, title: string, message?: string, duration = DEFAULT_DURATION): number {
    const id = nextId++
    state.items.push({ id, kind, title, message, duration })
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

  pause(id: number): void {
    clearTimer(id)
  },

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
