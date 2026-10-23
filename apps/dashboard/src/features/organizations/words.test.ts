import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ERROR_CODES } from '@tula-tech/contract'
import { ApiError } from '~/api/errors'
import { entryImports } from '~/testing/entry-imports'
import { matchesSearch } from './organizations-screen'
import { permissionProblem } from './role-dialogs'
import {
  invitationStatusLabel,
  isDisabled,
  isStaleVersion,
  lastManagerOrganizationIds,
  organizationMessageFor,
  ROLE_CHANGED_SINCE_OPENED,
  roleGainSentences,
  roleKeyLabel,
  roleKind,
  slugFromName,
  systemPermissionWords,
} from './words'

const refusal = (status: number, code: string, params?: Record<string, unknown>) =>
  new ApiError({ status, code, detail: 'Server words.', params })

// The refusals an administrator's call can meet. The others of the area belong to the client
// routes (a user creating, joining or leaving) and are not drawn by these screens.
const ADMIN_CODES = [
  'organization.disabled',
  'organization.slug_taken',
  'organization.member_exists',
  'organization.last_manager',
  'organization.role_unknown',
  'organization.role_exists',
  'organization.role_in_use',
  'organization.role_built_in',
  'organization.role_limit',
  'organization.invitation_exists',
  'organization.invitation_not_found',
  'organization.invitation_role_gone',
  'user.last_organization_manager',
]

describe('what the screens say of a refusal', () => {
  test.each(ADMIN_CODES)('%s is a code of the contract and has a sentence of its own', (code) => {
    // A rename in the contract fails here instead of falling back to the server's words.
    expect(ERROR_CODES as readonly string[]).toContain(code)
    expect(organizationMessageFor(refusal(409, code, { max: 50, count: 1 }))).not.toBe(
      'Server words.'
    )
  })

  test('a disabled environment, a stale version and a limit are told apart', () => {
    expect(isDisabled(refusal(403, 'organization.disabled'))).toBe(true)
    expect(isDisabled(refusal(403, 'auth.forbidden'))).toBe(false)
    expect(isDisabled(new Error('offline'))).toBe(false)
    expect(isStaleVersion(refusal(412, 'precondition.failed'))).toBe(true)
    expect(isStaleVersion(refusal(412, 'anything'))).toBe(true)
    expect(isStaleVersion(refusal(409, 'organization.role_exists'))).toBe(false)
    expect(organizationMessageFor(refusal(412, 'precondition.failed'))).toBe(
      ROLE_CHANGED_SINCE_OPENED
    )
    expect(organizationMessageFor(refusal(409, 'organization.role_limit', { max: 50 }))).toContain(
      '(50)'
    )
    // A limit that is not a number is not repeated; the contract's own cap is.
    expect(
      organizationMessageFor(refusal(409, 'organization.role_limit', { max: 'lots' }))
    ).toContain('(50)')
  })

  test('the user’s last-manager refusal is told in the singular and the plural', () => {
    const one = organizationMessageFor(refusal(409, 'user.last_organization_manager', { count: 1 }))
    expect(one).toContain('only manager of an organization.')
    const many = organizationMessageFor(
      refusal(409, 'user.last_organization_manager', { count: 3 })
    )
    expect(many).toContain('only manager of 3 organizations.')
    // The count is not trusted to be a number.
    expect(
      organizationMessageFor(refusal(409, 'user.last_organization_manager', { count: '3' }))
    ).toContain('only manager of an organization.')
  })

  test('the organizations a refusal names are ids, at most what the server sent', () => {
    const ids = ['00000000-0000-7000-8000-0000000aaa01', '00000000-0000-7000-8000-0000000aaa02']
    expect(
      lastManagerOrganizationIds(
        refusal(409, 'user.last_organization_manager', { organizationIds: ids.join(',') })
      )
    ).toEqual(ids)
    // Anything that is not an id is dropped, never put in a link.
    expect(
      lastManagerOrganizationIds(
        refusal(409, 'user.last_organization_manager', {
          organizationIds: `${ids[0]},../../evil,javascript:alert(1)`,
        })
      )
    ).toEqual([ids[0] as string])
    expect(lastManagerOrganizationIds(refusal(409, 'user.last_organization_manager'))).toEqual([])
    expect(
      lastManagerOrganizationIds(
        refusal(409, 'organization.last_manager', { organizationIds: ids[0] })
      )
    ).toEqual([])
    expect(lastManagerOrganizationIds(null)).toEqual([])
  })
})

describe('roles and permissions in words', () => {
  test('a system permission has words, any other key has none', () => {
    expect(systemPermissionWords('org:sys:memberships:manage')?.label).toBe('Manage the members')
    expect(systemPermissionWords('org:billing:read')).toBeNull()
    expect(systemPermissionWords('constructor')).toBeNull()
  })

  test('a role is built in or custom by its key', () => {
    expect(roleKind('admin')).toBe('Built in')
    expect(roleKind('member')).toBe('Built in')
    expect(roleKind('billing')).toBe('Custom')
    expect(roleKeyLabel('bill ing‮')).toBe('bill\\u{20}ing\\u{202E}')
  })

  test('the question before a role gains permissions names each one, once or many', () => {
    const [one] = roleGainSentences(['org:sys:memberships:manage'])
    expect(one).toContain('gains a permission')
    expect(one).toContain('Manage the members')
    const [many] = roleGainSentences(['org:sys:memberships:manage', 'org:billing:write'])
    expect(many).toContain('gains 2 permissions')
    expect(many).toContain('org:billing:write')
  })

  test('a permission key is checked with the contract’s grammar and says what is wrong', () => {
    expect(permissionProblem(['org:billing:read'])).toBeUndefined()
    expect(permissionProblem(['org:sys:memberships:read'])).toBeUndefined()
    expect(permissionProblem(['billing.read'])).toContain('is not a permission key')
    expect(permissionProblem(['org:sys:billing:read'])).toContain('reserved sys feature')
    // What cannot be seen in a key is written out, not drawn.
    expect(permissionProblem(['org:bill\u{200B}ing:read'])).toContain('\\u{200B}')
  })

  test.each([
    ['pending', 'Pending'],
    ['revoked', 'Withdrawn'],
    ['expired', 'Expired'],
    ['constructor', 'constructor'],
    ['mystery‮', 'mystery\\u{202E}'],
  ])('an invitation that is %s reads %s', (status, label) => {
    expect(invitationStatusLabel(status)).toBe(label)
  })
})

describe('slugs and the search', () => {
  test.each([
    ['Northline Labs', 'northline-labs'],
    ['  Acme   Corp!  ', 'acme-corp'],
    ['Café Münster', 'cafe-munster'],
    ['日本語', ''],
    ['', ''],
    ['A'.repeat(60), 'a'.repeat(48)],
    [`${'a'.repeat(47)} b`, 'a'.repeat(47)],
  ])('the slug of %j is %j', (name, slug) => {
    expect(slugFromName(name)).toBe(slug)
  })

  test('the search looks at the name and the slug, ignoring case and spaces at the ends', () => {
    const organization = { name: 'Acme Corp', slug: 'acme-co' }
    expect(matchesSearch(organization, '')).toBe(true)
    expect(matchesSearch(organization, '  ACME ')).toBe(true)
    expect(matchesSearch(organization, 'corp')).toBe(true)
    expect(matchesSearch(organization, 'acme-co')).toBe(true)
    expect(matchesSearch(organization, 'globex')).toBe(false)
  })
})

describe('what a route file runs before its screen is loaded stays free of Zod', () => {
  // `validateSearch` is part of the entry chunk and runs before `lib/zod-csp.ts` has told Zod
  // not to probe `new Function` (`.claude/rules/dashboard.md`).
  const SRC = join(import.meta.dir, '../..')
  const BASE = 'routes/_app/w.$workspaceId/p.$projectId/e.$environmentId'
  const ROUTE_FILES = [
    'organizations/index.tsx',
    'organizations/$organizationId.tsx',
    'roles.tsx',
    'organization-settings.tsx',
  ].map((file) => join(SRC, BASE, file))

  test('each route file names a screen, and nothing it imports reaches Zod or the schemas', () => {
    for (const file of ROUTE_FILES) {
      const { lazy, forbidden } = entryImports(file, SRC)
      expect(lazy.length).toBe(1)
      expect(forbidden).toEqual([])
    }
  })
})
