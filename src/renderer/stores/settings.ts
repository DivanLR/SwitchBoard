// Settings state (FR-021). The store owns the settings transport so components
// render state and call actions (view/transport separation).
//
// Stores here are plain module singletons built on Vue's own reactive(): state,
// getters and actions on one object, which is all the app ever used a store
// library for. Components keep calling useXStore() and read/write the same way.
import { reactive } from 'vue'
import type { Settings } from '@shared/domain'
import { invoke } from '@renderer/ipc'

// Ticket per save, so a reply that lost the race cannot overwrite local state.
let latest = 0

const store = reactive({
  settings: null as Settings | null,

  async load(): Promise<void> {
    latest += 1
    this.settings = await invoke('settings.get', undefined)
  },

  /**
   * Applies the patch locally FIRST, then persists it.
   *
   * Every caller that edits a whole-value setting — the project groups array, the
   * MCP roster, the per-project maps — builds the next value by reading
   * `settings` and rewriting it. Waiting for the round trip before the read sees
   * the change made a second edit that started first-in silently drop the one
   * before it: typing a group name and then clicking "new group" (which blurs the
   * name field, so both writes are in flight together) rebuilt the array from a
   * copy that still held the old name, and the rename was gone. Two clicks in one
   * tick lost a whole group the same way.
   *
   * Only the newest reply may replace state wholesale, because an older one
   * carries the store as it was before the newer patch and would undo it.
   */
  async save(patch: Partial<Settings>): Promise<void> {
    if (this.settings) this.settings = { ...this.settings, ...patch }
    const ticket = (latest += 1)
    const saved = await invoke('settings.set', patch)
    if (ticket === latest) this.settings = saved
  },
})

export const useSettingsStore = (): typeof store => store
