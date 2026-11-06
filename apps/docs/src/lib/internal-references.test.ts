import { describe, expect, test } from 'bun:test'
import { checkInternalReferences, findInternalReferences } from './internal-references'
import { RenderError } from './markdown'

describe('findInternalReferences', () => {
  test.each([
    'See ADR 0006 for why',
    'see adr-0042',
    'ADR0007',
    'tracked in TULA-199',
    'finding H-012 of the audit',
    '<a href="https://github.com/x/blob/develop/docs/adr/0006.md">notes</a>',
    '[plan](docs/plans/phase-1.md)',
    '[map](../codebase-map/README.md)',
    '<a href="/docs/internal/releasing/">releasing</a>',
    'delete the organization (Orgs 07). Read from',
    'invitation token (Orgs 04).',
    'the SAML verifier (SSO 01)',
  ])('flags %s', (line) => {
    expect(findInternalReferences(new Map([['a.md', line]]))).toHaveLength(1)
  })

  test.each([
    'An address of ADRESS-0006 is not one',
    'the H-12 heading and TULA- alone',
    'Tula auth plans for the future',
    'a link to docs/methods/password.md',
    'Orgs 7 and SSO login are fine',
    'the orgs 07 lower case word',
    'Choose SSO 1 or two',
  ])('lets %s through', (line) => {
    expect(findInternalReferences(new Map([['a.md', line]]))).toEqual([])
  })

  test('flags an id split by a line break, at the line where it starts', () => {
    const found = findInternalReferences(
      new Map([['a.md', 'fine\nthrough the client routes (ADR\n0065).\nok']])
    )
    expect(found.map((hit) => hit.line)).toEqual([2])
  })

  test('reports the file, the line number and the text', () => {
    const found = findInternalReferences(
      new Map([['methods/password.md', 'fine\nsecond ADR 0006 line\nTULA-5']])
    )
    expect(found).toEqual([
      { file: 'methods/password.md', line: 2, text: 'second ADR 0006 line' },
      { file: 'methods/password.md', line: 3, text: 'TULA-5' },
    ])
  })
})

describe('checkInternalReferences', () => {
  test('passes clean files', () => {
    expect(() => checkInternalReferences(new Map([['a.md', 'clean']]))).not.toThrow()
  })

  test('lists every offending file and line', () => {
    const files = new Map([
      ['a.md', 'ADR 0001'],
      ['b.html', 'ok\nH-001'],
    ])
    expect(() => checkInternalReferences(files)).toThrow(RenderError)
    expect(() => checkInternalReferences(files)).toThrow(/a\.md:1[\s\S]*b\.html:2/)
  })

  test('one offending line anywhere fails: there is no allow-list', () => {
    expect(() => checkInternalReferences(new Map([['llms-full.txt', 'ok\nTULA-5']]))).toThrow(
      /llms-full\.txt:2/
    )
  })
})
