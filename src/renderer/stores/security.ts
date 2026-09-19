import { reactive } from 'vue'
import type { SecurityRun, SecurityScope } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSkillsStore } from '@renderer/stores/skills'

export const SECURITY_SKILL_NAME = 'security-audit'

export const SECURITY_SKILL_URL = 'https://github.com/cloudflare/security-audit-skill/tree/main/skills'

let requestToken = 0

const store = reactive({
  byProject: {} as Record<string, SecurityRun[]>,
  error: null as string | null,
  starting: false,
  installing: false,

  listFor(projectId: string): SecurityRun[] {
    return this.byProject[projectId] ?? []
  },

  latestFor(projectId: string): SecurityRun | null {
    return this.listFor(projectId)[0] ?? null
  },

  runningFor(projectId: string): SecurityRun | null {
    return this.listFor(projectId).find((run) => run.status === 'running') ?? null
  },

  async load(projectId: string): Promise<void> {
    const token = ++requestToken
    const runs = await invoke('security.list', { projectId })
    if (token !== requestToken) return
    this.byProject[projectId] = runs
  },

  applyPush(projectId: string, runs: SecurityRun[]): void {
    this.byProject[projectId] = runs
  },

  async install(): Promise<boolean> {
    this.error = null
    this.installing = true
    try {
      const skills = useSkillsStore()
      await skills.import(SECURITY_SKILL_URL)
      return skills.items.some((skill) => skill.name === SECURITY_SKILL_NAME && skill.enabled)
    } finally {
      this.installing = false
    }
  },

  async start(projectId: string, scope: SecurityScope): Promise<boolean> {
    this.error = null
    this.starting = true
    try {
      const { runs } = await invoke('security.start', { projectId, scope })
      this.byProject[projectId] = runs
      await useProjectsStore().refresh()
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    } finally {
      this.starting = false
    }
  },

  async cancel(projectId: string, runId: string): Promise<boolean> {
    this.error = null
    try {
      this.byProject[projectId] = await invoke('security.cancel', { projectId, runId })
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    }
  },

  async openReport(projectId: string, runId: string, file: string): Promise<boolean> {
    this.error = null
    try {
      await invoke('security.openReport', { projectId, runId, file })
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    }
  },
})

export const useSecurityStore = (): typeof store => store
