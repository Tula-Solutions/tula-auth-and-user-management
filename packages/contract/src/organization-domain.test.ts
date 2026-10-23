import { describe, expect, test } from 'bun:test'
import { ERROR_DEFINITIONS } from './error-codes'
import { EVENT_FIXTURES } from './event-fixtures'
import { EVENT_DATA_SCHEMAS } from './events'
import {
  OrganizationDomainSchema,
  StartOrganizationDomainRequestSchema,
  UpdateOrganizationDomainRequestSchema,
  VerifyOrganizationDomainRequestSchema,
} from './organization-domain'
import {
  DOMAIN_PATTERN,
  domainOfAddress,
  domainRefusal,
  isPublicEmailDomain,
  MAX_DOMAIN_LABEL_LENGTH,
  MAX_DOMAIN_LENGTH,
  PUBLIC_EMAIL_DOMAINS,
} from './organization-domain-rules'

describe('domainRefusal', () => {
  test.each([
    'acme.com',
    'northline.app',
    'mail.northline.app',
    'a-b.example.co.uk',
    'xn--bcher-kva.example',
    '9lives.io',
    'yahoo.acme.com',
    'notyahoo.com',
  ])('%s can be claimed', (domain) => {
    expect(domainRefusal(domain)).toBeNull()
  })

  test.each([
    ['upper case', 'Acme.com'],
    ['unicode', 'bücher.example'],
    ['an IPv4 address', '192.168.0.1'],
    ['an IPv4 address with a letter', '1.2.3.4a'],
    ['a bracketed IPv6 address', '[::1]'],
    ['a trailing full stop', 'acme.com.'],
    ['a leading full stop', '.acme.com'],
    ['a double full stop', 'acme..com'],
    ['an underscore', 'ac_me.com'],
    ['a hyphen at a label’s start', '-acme.com'],
    ['a hyphen at a label’s end', 'acme-.com'],
    ['a single label', 'localhost'],
    ['a wildcard', '*.acme.com'],
    ['a port', 'acme.com:8080'],
    ['a path', 'acme.com/path'],
    ['an address', 'ada@acme.com'],
    ['a space', 'acme .com'],
    ['a numeric top-level label', 'acme.123'],
    ['a one-letter top-level label', 'acme.c'],
    ['nothing', ''],
    ['more than twice the length cap', `${'a'.repeat(600)}.com`],
  ])('%s is refused as grammar', (_name, domain) => {
    expect(domainRefusal(domain)).toBe('grammar')
  })

  test('length bounds: a label of 64, a name of 254, and the shortest', () => {
    expect(domainRefusal(`${'a'.repeat(MAX_DOMAIN_LABEL_LENGTH)}.com`)).toBeNull()
    expect(domainRefusal(`${'a'.repeat(MAX_DOMAIN_LABEL_LENGTH + 1)}.com`)).toBe('length')
    const long = `${`${'a'.repeat(60)}.`.repeat(5)}com`
    expect(long.length).toBeGreaterThan(MAX_DOMAIN_LENGTH)
    expect(domainRefusal(long)).toBe('length')
    expect(domainRefusal('a.bc')).toBeNull()
    expect(domainRefusal('a.b')).toBe('grammar')
  })

  test.each([
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'hotmail.co.uk',
    'hotmail.fr',
    'yahoo.com',
    'yahoo.co.uk',
    'yahoo.co.jp',
    'yahoo.com.br',
    'icloud.com',
    'proton.me',
    'protonmail.com',
    'aol.com',
    'gmx.de',
    'web.de',
    'mail.ru',
    'qq.com',
    'duck.com',
    'privaterelay.appleid.com',
    'simplelogin.com',
    'mailinator.com',
    'yopmail.com',
  ])('%s is a public mail domain', (domain) => {
    expect(isPublicEmailDomain(domain)).toBe(true)
    expect(domainRefusal(domain)).toBe('public')
  })

  test('every listed public domain satisfies the grammar and none is claimable', () => {
    for (const domain of PUBLIC_EMAIL_DOMAINS) {
      expect(DOMAIN_PATTERN.test(domain)).toBe(true)
      expect(domainRefusal(domain)).toBe('public')
    }
    expect(new Set(PUBLIC_EMAIL_DOMAINS).size).toBe(PUBLIC_EMAIL_DOMAINS.length)
  })

  test('a provider’s name inside a company’s domain is not public', () => {
    for (const domain of [
      'yahoo.acme.com',
      'gmail.acme.io',
      'mygmail.com',
      'outlook.example.org',
    ]) {
      expect(isPublicEmailDomain(domain)).toBe(false)
    }
  })
})

describe('domainOfAddress', () => {
  test.each([
    ['ada@acme.com', 'acme.com'],
    ['ada@mail.acme.com', 'mail.acme.com'],
    ['"a@b"@acme.com', 'acme.com'],
    ['ada@', null],
    ['@acme.com', null],
    ['nope', null],
  ])('%s gives %p', (address, expected) => {
    expect(domainOfAddress(address)).toBe(expected)
  })
})

describe('organization domain schemas', () => {
  test('a start request holds a domain, an address and a mode, and says why a bad domain is bad', () => {
    const ok = { domain: 'acme.com', email: 'ada@acme.com', mode: 'suggest' }
    expect(StartOrganizationDomainRequestSchema.safeParse(ok).success).toBe(true)
    for (const bad of [
      { ...ok, domain: 'Acme.com' },
      { ...ok, domain: 'bücher.example' },
      { ...ok, domain: '10.0.0.1' },
      { ...ok, mode: 'everyone' },
      { ...ok, extra: true },
      { domain: 'acme.com', email: 'ada@acme.com' },
    ]) {
      expect(StartOrganizationDomainRequestSchema.safeParse(bad).success).toBe(false)
    }
  })

  test('a code is exactly six digits', () => {
    for (const code of ['123456', '000000']) {
      expect(VerifyOrganizationDomainRequestSchema.safeParse({ code }).success).toBe(true)
    }
    for (const code of ['12345', '1234567', 'abcdef', '12 456', 123456, null]) {
      expect(VerifyOrganizationDomainRequestSchema.safeParse({ code }).success).toBe(false)
    }
  })

  test('an update holds a mode and nothing else', () => {
    expect(UpdateOrganizationDomainRequestSchema.safeParse({ mode: 'auto_join' }).success).toBe(
      true
    )
    expect(UpdateOrganizationDomainRequestSchema.safeParse({}).success).toBe(false)
    expect(
      UpdateOrganizationDomainRequestSchema.safeParse({ mode: 'suggest', domain: 'x.com' }).success
    ).toBe(false)
  })

  test('a domain on the wire never carries the code or its hash', () => {
    const keys = Object.keys(OrganizationDomainSchema.shape)
    expect(keys.sort()).toEqual(
      [
        'codeExpiresAt',
        'createdAt',
        'domain',
        'expiresAt',
        'id',
        'mode',
        'status',
        'updatedAt',
        'verifiedAt',
      ].sort()
    )
  })
})

describe('the domain error codes and events', () => {
  test.each([
    ['organization.domain_public', 422],
    ['organization.domain_taken', 409],
    ['organization.domain_address_mismatch', 422],
    ['organization.domain_limit', 409],
    ['organization.suggestion_unavailable', 403],
  ])('%s is defined with status %p', (code, status) => {
    expect(ERROR_DEFINITIONS[code as keyof typeof ERROR_DEFINITIONS]?.status as number).toBe(status)
  })

  test.each([
    'organization_domain.claimed',
    'organization_domain.verified',
    'organization_domain.updated',
    'organization_domain.removed',
  ] as const)('%s has a schema and a fixture that satisfies it, with no address in it', (type) => {
    const data = EVENT_FIXTURES[type].data
    expect(EVENT_DATA_SCHEMAS[type].safeParse(data).success).toBe(true)
    expect(JSON.stringify(data)).not.toContain('@')
  })

  test('a domain event drops a field the contract does not name', () => {
    const data = EVENT_FIXTURES['organization_domain.claimed'].data
    const parsed = EVENT_DATA_SCHEMAS['organization_domain.claimed'].parse({
      ...data,
      email: 'a@b.co',
    })
    expect(JSON.stringify(parsed)).not.toContain('a@b.co')
  })

  test('a membership added by a domain says which way, from a closed set', () => {
    const data = EVENT_FIXTURES['organization_membership.added'].data
    const schema = EVENT_DATA_SCHEMAS['organization_membership.added']
    expect(schema.safeParse({ ...data, via: 'domain_auto_join' }).success).toBe(true)
    expect(schema.safeParse({ ...data, via: 'domain_suggestion' }).success).toBe(true)
    expect(schema.safeParse({ ...data, via: 'ada@acme.com' }).success).toBe(false)
    const { via: _via, ...without } = data as Record<string, unknown>
    expect(schema.safeParse(without).success).toBe(true)
  })
})
