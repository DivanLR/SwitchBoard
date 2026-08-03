// Settings state (FR-021). The store owns the settings transport so components
// render state and call actions (view/transport separation).
//
// Stores here are plain module singletons built on Vue's own reactive(): state,
// getters and actions on one object, which is all the app ever used a store
// library for. Components keep calling useXStore() and read/write the same way.
import { reactive } from 'vue'
import type { AvailableModel, Settings } from '@shared/domain'
import { invoke } from '@renderer/ipc'

// Ticket per save, so a reply that lost the race cannot overwrite local state.
let latest = 0

const store = reactive({
  settings: null as Settings | null,
  /** Models this subscription can select, read from the CLI by the main process.
   *  Empty until loaded; the picker falls back to the account default. */
  availableModels: [] as AvailableModel[],

  async load(): Promise<void> {
    latest += 1
    this.settings = await invoke('settings.get', undefined)
  },

  /** The selectable model list. Silent on failure: no session has initialised
   *  yet, and the picker still offers the account default. */
  async loadAvailableModels(): Promise<void> {
    try {
      this.availableModels = await invoke('models.available', undefined)
    } catch {
      // Keep whatever the list already had.
    }
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

  /**
   * Add or remove one server from the active MCP combination.
   *
   * The next value is derived here rather than in the view because it is real
   * application data. A fast second click is already safe: `save` applies the
   * patch locally before it awaits, so the read below sees the previous toggle
   * rather than a stale pre-save snapshot.
   */
  toggleMcpActiveServer(name: string): void {
    const current = this.settings?.mcpActiveServers
    if (!current) return
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
    void this.save({ mcpActiveServers: next })
  },

  /** Re-activate a previously scanned combination, putting its servers back on
   *  the roster so each one stays tickable. */
  activateMcpCombo(servers: readonly string[]): void {
    if (!this.settings) return
    const roster = new Set([...this.settings.databaseMcpServers, ...servers])
    void this.save({ databaseMcpServers: [...roster], mcpActiveServers: [...servers] })
  },
})

export const useSettingsStore = (): typeof store => store
