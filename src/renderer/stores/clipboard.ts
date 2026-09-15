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

  async read(): Promise<string> {
    try {
      return (await invoke('clipboard.read', undefined)).text
    } catch {
      return ''
    }
  },
}

export const useClipboardStore = (): typeof store => store
