// Putting text on the system clipboard.
//
// A store rather than a call inside the component that needs it, because only
// stores may `invoke` in this codebase (ESLint enforces it) and this has to go
// through the main process. It holds no state; it exists to own the transport.
//
// WHY THE MAIN PROCESS. `navigator.clipboard.writeText` in the renderer looked
// like the simpler answer and broke twice:
//
//   1. Electron routes it through the session's permission handlers, and this app
//      denies renderer permissions by default (index.ts, checklist A5). Every
//      write rejected, so every code-block copy reported that it could not copy.
//   2. It also requires a focused document and rejects without one, which is a
//      second, intermittent version of the same visible failure.
//
// Both look identical to the developer, and both are invisible to the mock-host
// test suite, which runs the renderer in a plain browser under Chromium's own
// permission model. The main process has unconditional clipboard access, so this
// path cannot be denied, does not care about focus, and does not break the next
// time a security handler is tightened.
import { invoke } from '@renderer/ipc'

const store = {
  /**
   * Write `text`, and answer whether it landed.
   *
   * Returns a boolean rather than throwing: every caller's question is "can I
   * show the confirmation", and a rejected copy is an ordinary outcome to report
   * rather than an exception to handle. The caller must never claim success on a
   * false.
   */
  async write(text: string): Promise<boolean> {
    try {
      await invoke('clipboard.write', { text })
      return true
    } catch {
      return false
    }
  },
}

export const useClipboardStore = (): typeof store => store
