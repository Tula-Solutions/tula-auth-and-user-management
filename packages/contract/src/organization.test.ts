import { describe, expect, test } from 'bun:test'
import { EnvironmentSettingsSchema } from './environment-settings'
import {
  AddOrganizationMemberRequestSchema,
  BUILT_IN_ROLES,
  CreateOrganizationRequestSchema,
  MAX_PERMISSIONS_PER_ROLE,
  MEMBERSHIPS_MANAGE_PERMISSION,
  ORGANIZATION_SLUG_PATTERN,
  PERMISSION_KEY_PATTERN,
  ROLE_KEY_PATTERN,
  SYSTEM_PERMISSIONS,
  UpdateOrganizationRequestSchema,
} from './organization'
import { settingsWeakenings } from './settings-weakening'

describe('slugs', () => {
  test.each(['ac', 'acme', 'acme-corp', 'a1-b2-c3', '2024'])('%s is a slug', (slug) => {
    expect(ORGANIZATION_SLUG_PATTERN.test(slug)).toBe(true)
  })

  test.each(['', 'Acme', '-acme', 'acme-', 'ac--me', 'ac me', 'ac_me', 'ac.me', 'acmé', 'a/b'])(
    '%j is not a slug',
    (slug) => {
      expect(ORGANIZATION_SLUG_PATTERN.test(slug)).toBe(false)
    }
  )

  test('a slug is 2 to 48 characters', () => {
    const parse = (slug: string) =>
      CreateOrganizationRequestSchema.safeParse({ name: 'Acme', slug }).success
    expect(parse('a')).toBe(false)
    expect(parse('ab')).toBe(true)
    expect(parse('a'.repeat(48))).toBe(true)
    expect(parse('a'.repeat(49))).toBe(false)
  })
})

describe('permission keys', () => {
  test.each(['org:billing:read', 'org:invoices:create_draft', 'org:sys:memberships:manage'])(
    '%s is a key',
    (key) => {
      expect(PERMISSION_KEY_PATTERN.test(key)).toBe(true)
    }
  )

  test.each([
    'billing.read',
    'org:billing',
    'org:Billing:read',
    'org:billing:read:more',
    'org:sys:read',
    'org:billing.x:read',
    'org::read',
    'org:billing:',
    'org:billing:re ad',
    `org:${'a'.repeat(33)}:read`,
  ])('%s is not a key', (key) => {
    expect(PERMISSION_KEY_PATTERN.test(key)).toBe(false)
  })

  test('every system permission is a key, and the manager permission is one of them', () => {
    for (const key of SYSTEM_PERMISSIONS) {
      expect(PERMISSION_KEY_PATTERN.test(key)).toBe(true)
      expect(key.startsWith('org:sys:')).toBe(true)
    }
    expect(SYSTEM_PERMISSIONS).toContain(MEMBERSHIPS_MANAGE_PERMISSION)
  })
})

describe('built-in roles', () => {
  test('are admin and member, with keys that follow the role grammar', () => {
    expect(BUILT_IN_ROLES.map((role) => role.key)).toEqual(['admin', 'member'])
    for (const role of BUILT_IN_ROLES) {
      expect(ROLE_KEY_PATTERN.test(role.key)).toBe(true)
      expect(role.permissions.length).toBeLessThanOrEqual(MAX_PERMISSIONS_PER_ROLE)
    }
  })

  test('admin holds every system permission and member can manage nobody', () => {
    const [admin, member] = BUILT_IN_ROLES
    expect(admin?.permissions).toEqual(SYSTEM_PERMISSIONS)
    expect(member?.permissions).not.toContain(MEMBERSHIPS_MANAGE_PERMISSION)
  })
})

describe('requests', () => {
  test('a name is trimmed and may not be empty or hold a control character', () => {
    const parse = (name: string) =>
      CreateOrganizationRequestSchema.safeParse({ name, slug: 'acme' })
    expect(parse('  Acme  ')).toMatchObject({ success: true, data: { name: 'Acme' } })
    expect(parse('   ').success).toBe(false)
    expect(parse('Ac\nme').success).toBe(false)
    expect(parse('Ac\u0085me').success).toBe(false)
    expect(parse('x'.repeat(101)).success).toBe(false)
  })

  test('an unknown key is refused', () => {
    expect(
      CreateOrganizationRequestSchema.safeParse({ name: 'Acme', slug: 'acme', owner: 'x' }).success
    ).toBe(false)
  })

  test('an update names at least one field', () => {
    expect(UpdateOrganizationRequestSchema.safeParse({}).success).toBe(false)
    expect(UpdateOrganizationRequestSchema.safeParse({ name: 'New' }).success).toBe(true)
    expect(UpdateOrganizationRequestSchema.safeParse({ slug: 'new' }).success).toBe(true)
  })

  test('adding a member needs a user id and a role key', () => {
    const userId = '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01'
    expect(AddOrganizationMemberRequestSchema.safeParse({ userId, role: 'member' }).success).toBe(
      true
    )
    expect(AddOrganizationMemberRequestSchema.safeParse({ userId, role: 'Member' }).success).toBe(
      false
    )
    expect(
      AddOrganizationMemberRequestSchema.safeParse({ userId: 'nope', role: 'member' }).success
    ).toBe(false)
  })
})

describe('the organizations settings', () => {
  const settings = (organizations: Record<string, unknown>) =>
    EnvironmentSettingsSchema.parse({ organizations })

  test('are off by default, and creation by users is off too', () => {
    expect(settings({}).organizations).toEqual({
      enabled: false,
      allowUserCreated: false,
      maxCreatedPerUser: 5,
      creatorRole: 'admin',
      defaultRole: 'member',
      personalAccount: true,
    })
  })

  test('refuse a role key outside the grammar and an unknown key', () => {
    expect(
      EnvironmentSettingsSchema.safeParse({ organizations: { defaultRole: 'Not A Key' } }).success
    ).toBe(false)
    expect(EnvironmentSettingsSchema.safeParse({ organizations: { cap: 1 } }).success).toBe(false)
  })

  test('weaken when organizations are switched off', () => {
    const on = settings({ enabled: true })
    expect(settingsWeakenings(on, settings({ enabled: false }))).toEqual(['organizations.enabled'])
    expect(settingsWeakenings(settings({ enabled: false }), on)).toEqual([])
  })

  test('weaken when users may create organizations', () => {
    expect(settingsWeakenings(settings({}), settings({ allowUserCreated: true }))).toEqual([
      'organizations.allowUserCreated',
    ])
    expect(settingsWeakenings(settings({ allowUserCreated: true }), settings({}))).toEqual([])
  })

  test('weaken when the cap is raised or removed, not when it is lowered', () => {
    const capped = (maxCreatedPerUser: number | null) => settings({ maxCreatedPerUser })
    expect(settingsWeakenings(capped(5), capped(6))).toEqual(['organizations.maxCreatedPerUser'])
    expect(settingsWeakenings(capped(5), capped(null))).toEqual(['organizations.maxCreatedPerUser'])
    expect(settingsWeakenings(capped(5), capped(4))).toEqual([])
    expect(settingsWeakenings(capped(null), capped(5))).toEqual([])
    expect(settingsWeakenings(capped(5), capped(5))).toEqual([])
  })
})
