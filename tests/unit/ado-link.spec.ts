import { describe, expect, it } from 'vitest'
import { adoTitle, checkedAdoSource, parseAdoFeatureLink } from '@shared/ado-link'

describe('parseAdoFeatureLink', () => {
  it('reads a dev.azure.com work item link', () => {
    expect(parseAdoFeatureLink('https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235')).toEqual({
      organisation: 'PepkorPL',
      project: 'A Plus',
      id: '40235',
      url: 'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235',
    })
  })

  it('reads a visualstudio.com work item link and gives it the dev.azure.com address', () => {
    expect(parseAdoFeatureLink('https://pepkorpl.visualstudio.com/Einstein/_workitems/edit/40921')).toEqual({
      organisation: 'pepkorpl',
      project: 'Einstein',
      id: '40921',
      url: 'https://dev.azure.com/pepkorpl/Einstein/_workitems/edit/40921',
    })
  })

  it.each([
    'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235/',
    'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235?src=WorkItemMention&src-action=artifact_link',
    'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235/?view=edit#comments',
    '  https://dev.azure.com/PepkorPL/A%20Plus/_WorkItems/Edit/40235  ',
  ])('ignores trailing slashes, query strings, fragments, case and whitespace: %s', (link) => {
    expect(parseAdoFeatureLink(link)).toMatchObject({ organisation: 'PepkorPL', project: 'A Plus', id: '40235' })
  })

  it('keeps the query string out of the address it gives back', () => {
    expect(parseAdoFeatureLink('https://pepkorpl.visualstudio.com/Einstein/_workitems/edit/40921/?fullScreen=true')?.url).toBe(
      'https://dev.azure.com/pepkorpl/Einstein/_workitems/edit/40921',
    )
  })

  it('reads a bare id with no project or organisation', () => {
    expect(parseAdoFeatureLink(' 40542 ')).toEqual({ organisation: null, project: null, id: '40542', url: null })
  })

  it.each([
    '',
    'abc',
    '0',
    '-4',
    '12345678901',
    '40235a',
    'http://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235',
    'https://user:pw@dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235',
    'https://dev.azure.com:8443/PepkorPL/A%20Plus/_workitems/edit/40235',
    'https://dev.azure.com.evil.example/PepkorPL/A%20Plus/_workitems/edit/40235',
    'https://evil.example/PepkorPL/A%20Plus/_workitems/edit/40235',
    'https://dev.azure.com/PepkorPL/_workitems/edit/40235',
    'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/40235',
    'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/abc',
    'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235/extra',
    'https://dev.azure.com/PepkorPL/A%2FPlus/_workitems/edit/40235',
    'https://dev.azure.com/PepkorPL/A%22Plus/_workitems/edit/40235',
    'https://dev.azure.com/PepkorPL/%E0%A4%A/_workitems/edit/40235',
    'https://dev.azure.com/Pep_kor/A%20Plus/_workitems/edit/40235',
    'https://a.b.visualstudio.com/Einstein/_workitems/edit/40921',
    'https://visualstudio.com/Einstein/_workitems/edit/40921',
    'javascript:alert(1)',
  ])('refuses %s', (link) => {
    expect(parseAdoFeatureLink(link)).toBeNull()
  })
})

describe('checkedAdoSource', () => {
  it('keeps a listed Feature and rewrites its link to the canonical address', () => {
    expect(
      checkedAdoSource({
        kind: 'ado',
        featureId: '40235',
        featureTitle: 'A+ Facial Biometrics Exemption Enhancement',
        url: 'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235?x=1',
      }),
    ).toEqual({
      kind: 'ado',
      featureId: '40235',
      featureTitle: 'A+ Facial Biometrics Exemption Enhancement',
      url: 'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40235',
    })
  })

  it('names a Feature without a title after its id', () => {
    expect(checkedAdoSource({ kind: 'ado', featureId: '40542', featureTitle: '  ', url: null })).toMatchObject({
      featureTitle: 'Feature 40542',
      url: null,
    })
  })

  it('refuses an id that is not a work item number, and a link to another work item', () => {
    expect(checkedAdoSource({ kind: 'ado', featureId: 'F-1', featureTitle: 'x', url: null })).toBeNull()
    expect(
      checkedAdoSource({
        kind: 'ado',
        featureId: '40235',
        featureTitle: 'x',
        url: 'https://dev.azure.com/PepkorPL/A%20Plus/_workitems/edit/40542',
      }),
    ).toBeNull()
    expect(checkedAdoSource({ kind: 'ado', featureId: '40235', featureTitle: 'x', url: 'https://evil.example/' })).toBeNull()
  })
})

describe('adoTitle', () => {
  it('keeps a title to one trimmed line of at most 200 characters', () => {
    expect(adoTitle('  Workforce\nAttendance\u0007 Management\tModule ')).toBe('Workforce Attendance Management Module')
    expect(adoTitle('x'.repeat(300))).toHaveLength(200)
    expect(adoTitle('   ')).toBeNull()
    expect(adoTitle(42)).toBeNull()
  })
})
