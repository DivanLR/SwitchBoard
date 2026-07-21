// unionMcpServerNames: the set-union that lets the global database session
// build its denylist from every server name seen across restarts.
import { describe, expect, it } from 'vitest'
import type { McpServer } from '@shared/domain'
import { unionMcpServerNames } from '@main/sessions/session-manager'

const s = (names: string[]): McpServer[] => names.map((name) => ({ name, status: 'connected' }))

describe('unionMcpServerNames', () => {
  it('dedups, sorts, and never shrinks the known set', () => {
    expect(unionMcpServerNames(['github'], s(['postgres', 'github']))).toEqual(['github', 'postgres'])
    // Reporting fewer servers must not drop names already known.
    expect(unionMcpServerNames(['a', 'b', 'c'], s(['a']))).toEqual(['a', 'b', 'c'])
    // Empty roster leaves the known set intact (sorted).
    expect(unionMcpServerNames(['z', 'a'], [])).toEqual(['a', 'z'])
  })
})
