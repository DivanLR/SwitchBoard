import { ref, watch, type Ref } from 'vue'
import type { PermissionRule } from '@shared/domain'
import { useInboxStore } from '@renderer/stores/inbox'

export const MATCHER_KIND_LABEL: Record<string, string> = {
  command_prefix: 'Commands starting with this',
  path_glob: 'Files under this folder',
  exact_input: 'This exact action only',
  tool_only: 'Any use of this tool',
}

export function useAllowedRules(opts: { projectId: () => string | undefined }) {
  const inbox = useInboxStore()

  const allowedRules = ref<PermissionRule[]>([])
  const newCmd = ref('')

  let load = 0
  async function loadAllowedRules(): Promise<void> {
    const ticket = (load += 1)
    const id = opts.projectId()
    const rules = id ? await inbox.listStandingRules(id, true) : []
    if (ticket === load) allowedRules.value = rules
  }

  watch(opts.projectId, () => void loadAllowedRules(), { immediate: true })

  async function setRuleMode(rule: PermissionRule, mode: 'ask' | 'auto'): Promise<void> {
    if (mode === 'ask' && rule.revokedAt === null) {
      await inbox.revokeStandingRule(rule.id)
    } else if (mode === 'auto' && rule.revokedAt !== null) {
      await inbox.restoreStandingRule(rule.id)
    }
    await loadAllowedRules()
  }

  async function addAllowedCommand(): Promise<void> {
    const pattern = newCmd.value.trim()
    const id = opts.projectId()
    if (!pattern || !id) return
    newCmd.value = ''
    await inbox.addStandingRule(id, pattern)
    await loadAllowedRules()
  }

  return { allowedRules, newCmd, loadAllowedRules, setRuleMode, addAllowedCommand } satisfies {
    allowedRules: Ref<PermissionRule[]>
    newCmd: Ref<string>
    loadAllowedRules: () => Promise<void>
    setRuleMode: (rule: PermissionRule, mode: 'ask' | 'auto') => Promise<void>
    addAllowedCommand: () => Promise<void>
  }
}
