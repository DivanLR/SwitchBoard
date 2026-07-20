// switchboard:// deep links arrive from OS protocol activation (untrusted);
// the parser must accept exactly the two verbs with a UUID and nothing else.
import { describe, expect, it } from 'vitest'
import { buildApprovalToastXml, parseDeepLink } from '@main/deep-link'

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'

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
    // Case-insensitive, normalised to lower case.
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
    // Both actions target the strict protocol URLs.
    expect(xml).toContain(`arguments="switchboard://approve/${UUID}"`)
    expect(xml).toContain(`arguments="switchboard://inbox/${UUID}"`)
    expect(xml).toContain(`launch="switchboard://inbox/${UUID}"`)
  })
})
