import { describe, expect, it } from 'vitest'
import { buildApprovalToastXml, followDeepLink, parseDeepLink } from '@main/deep-link'

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('followDeepLink', () => {
  const broker = (needsConfirmation: boolean) => {
    const confirmations: boolean[] = []
    return {
      confirmations,
      decide: (_id: string, _decision: 'approve' | 'deny', confirmHighRisk = false) => {
        confirmations.push(confirmHighRisk)
        if (needsConfirmation && !confirmHighRisk) throw new Error('CONFIRM_REQUIRED')
        return { delivered: true }
      },
    }
  }

  it('never confirms a high-risk approval from a toast, and opens the inbox on that item instead', () => {
    const b = broker(true)
    const opened: string[] = []
    followDeepLink(`switchboard://approve/${UUID}`, b, (id) => opened.push(id))
    expect(b.confirmations).toEqual([false])
    expect(opened).toEqual([UUID])
  })

  it('approves straight from the toast when the request needs no confirmation', () => {
    const b = broker(false)
    const opened: string[] = []
    followDeepLink(`switchboard://approve/${UUID}`, b, (id) => opened.push(id))
    expect(b.confirmations).toEqual([false])
    expect(opened).toEqual([])
  })

  it('opens the inbox for an inbox link without deciding anything', () => {
    const b = broker(false)
    const opened: string[] = []
    followDeepLink(`switchboard://inbox/${UUID}`, b, (id) => opened.push(id))
    expect(b.confirmations).toEqual([])
    expect(opened).toEqual([UUID])
  })
})

describe('parseDeepLink', () => {
  it('parses approve and inbox links with a UUID', () => {
    expect(parseDeepLink(`switchboard://approve/${UUID}`)).toEqual({
      verb: 'approve',
      requestId: UUID,
    })
    expect(parseDeepLink(`switchboard://inbox/${UUID}/`)).toEqual({
      verb: 'inbox',
      requestId: UUID,
    })
    expect(parseDeepLink(`SWITCHBOARD://Approve/${UUID.toUpperCase()}`)?.requestId).toBe(UUID)
  })

  it('rejects unknown verbs, malformed ids, and smuggled extras', () => {
    expect(parseDeepLink(`switchboard://deny/${UUID}`)).toBeNull()
    expect(parseDeepLink('switchboard://approve/not-a-uuid')).toBeNull()
    expect(parseDeepLink(`switchboard://approve/${UUID}/extra`)).toBeNull()
    expect(parseDeepLink(`switchboard://approve/${UUID}?x=1`)).toBeNull()
    expect(parseDeepLink(`https://evil.example/approve/${UUID}`)).toBeNull()
    expect(parseDeepLink('')).toBeNull()
  })
})

describe('buildApprovalToastXml', () => {
  it('escapes XML metacharacters in the project name and title', () => {
    const xml = buildApprovalToastXml({
      requestId: UUID,
      projectName: 'a<b>&"proj"',
      kindLabel: 'Permission request',
      title: `Run: echo '<script>'`,
    })
    expect(xml).not.toContain('<script>')
    expect(xml).toContain('&lt;script&gt;')
    expect(xml).toContain('a&lt;b&gt;&amp;&quot;proj&quot;')
    expect(xml).toContain(`arguments="switchboard://approve/${UUID}"`)
    expect(xml).toContain(`arguments="switchboard://inbox/${UUID}"`)
    expect(xml).toContain(`launch="switchboard://inbox/${UUID}"`)
  })
})
