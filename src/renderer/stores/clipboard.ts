import { invoke } from '@renderer/ipc'

const store = {
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
