import { join, resolve, sep } from 'node:path'
import type { FlowKind, FlowStage } from '@shared/domain'
import type { FlowArtefactKind } from '@shared/ipc-types'
import { sddReportOf } from '@shared/sdd'

export function resolveArtefactPath(worktreePath: string, relativePath: string): string | null {
  const root = resolve(worktreePath)
  const abs = resolve(root, relativePath)
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

export function defaultArtefactKind(stage: FlowStage, kind: FlowKind = 'feature'): FlowArtefactKind {
  if (sddReportOf(kind, stage)) return 'doc'
  if (stage === 'spec') return 'spec'
  if (stage === 'test') return 'report'
  return 'tasks'
}

export function artefactRelPath(specDir: string | null, kind: FlowArtefactKind): string | null {
  if (kind === 'report' || kind === 'doc' || !specDir) return null
  if (kind === 'spec') return join(specDir, 'spec.md')
  if (kind === 'plan') return join(specDir, 'plan.md')
  if (kind === 'tasks') return join(specDir, 'tasks.md')
  if (kind === 'postman') return join(specDir, 'postman')
  return null
}
