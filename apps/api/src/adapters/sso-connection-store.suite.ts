import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { SsoConnectionRecord, SsoConnectionStore } from '~/ports/sso-connection-store'

/** A tenant for the suite. */
export interface SsoSuiteTenant {
  projectId: string
  environmentId: string
}

/** What the store under test provides. */
export interface SsoSuiteContext {
  store: SsoConnectionStore
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  /** Makes an organization of the tenant and returns its id. */
  organization: (tenant: SsoSuiteTenant) => Promise<string>
  /** Deletes the organization as the database does: the cascade is what is under test. */
  deleteOrganization: (tenant: SsoSuiteTenant, organizationId: string) => Promise<void>
  /** Makes a user of the tenant and returns its id. */
  user: (tenant: SsoSuiteTenant) => Promise<string>
  a: SsoSuiteTenant
  b: SsoSuiteTenant
}

/**
 * Behaviour every `SsoConnectionStore` must have. Run against each adapter so the memory
 * store used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeSsoConnectionStore(
  name: string,
  setup: () => Promise<SsoSuiteContext>
): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2026-01-02T00:00:00.000Z')
  let ctx: SsoSuiteContext
  let org: string

  function connection(
    tenant: SsoSuiteTenant,
    organizationId: string,
    overrides: Partial<SsoConnectionRecord> = {}
  ): SsoConnectionRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId,
      protocol: 'oidc',
      saml: null,
      name: 'Okta',
      status: 'draft',
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      clientSecretSealed: 'sealed',
      attributeMapping: null,
      defaultRole: 'member',
      enforced: false,
      breakGlassRole: null,
      trustIdpMfa: false,
      domains: ['acme.test'],
      testedFingerprint: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  function activity(
    tenant: SsoSuiteTenant,
    type: 'sso_connection.created' | 'sso_connection.updated' | 'sso_connection.deleted',
    id: string
  ): Activity {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    const actor = { type: 'admin', id: null, ipAddress: null, userAgent: null } as const
    const target = { type: 'sso_connection', id } as const
    const protocol = 'oidc' as const
    if (type === 'sso_connection.created') {
      return Audit.entry(deps, scope, {
        type,
        actor,
        target,
        data: { protocol, status: 'draft', domains: 1 },
      })
    }
    if (type === 'sso_connection.updated') {
      return Audit.entry(deps, scope, {
        type,
        actor,
        target,
        data: { protocol, changed: ['status'], status: 'active' },
      })
    }
    return Audit.entry(deps, scope, { type, actor, target, data: { protocol } })
  }

  /** The entry an identity is linked with: what the SSO sign-in records. */
  function linked(tenant: SsoSuiteTenant, userId: string, connectionId: string): Activity {
    return Audit.entry(
      { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } },
      { projectId: tenant.projectId, environmentId: tenant.environmentId },
      {
        type: 'user.sso_linked',
        actor: { type: 'user', id: userId, ipAddress: null, userAgent: null },
        target: { type: 'user', id: userId },
        data: { connectionId, method: 'email' },
      }
    )
  }

  async function insert(record: SsoConnectionRecord) {
    return ctx.store.insert(record, activity(ctx.a, 'sso_connection.created', record.id))
  }

  function update(id: string, changes: Parameters<SsoConnectionStore['update']>[2]) {
    return ctx.store.update(
      ctx.a.environmentId,
      id,
      changes,
      later,
      activity(ctx.a, 'sso_connection.updated', id)
    )
  }

  describe(`SsoConnectionStore (${name})`, () => {
    beforeEach(async () => {
      ctx = await setup()
      org = await ctx.organization(ctx.a)
    })

    test('stores a connection and reads it back with sorted domains', async () => {
      const record = connection(ctx.a, org, { domains: ['b.test', 'a.test'] })
      const stored = await insert(record)
      const expected = { ...record, domains: ['a.test', 'b.test'] }
      expect(stored).toEqual(expected)
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(expected)
      expect(await ctx.store.list(ctx.a.environmentId, org)).toEqual([expected])
      expect(await ctx.recorded()).toEqual(['sso_connection.created'])
    })

    test('lists the whole environment when no organization is named', async () => {
      const other = await ctx.organization(ctx.a)
      const one = connection(ctx.a, org, { name: 'one', domains: ['one.test'] })
      const two = connection(ctx.a, other, { name: 'two', domains: ['two.test'] })
      await insert(one)
      await insert(two)
      const ids = (await ctx.store.list(ctx.a.environmentId)).map((r) => r.id).sort()
      expect(ids).toEqual([one.id, two.id].sort())
      expect(await ctx.store.list(ctx.b.environmentId)).toEqual([])
    })

    test('another environment sees nothing', async () => {
      const record = connection(ctx.a, org)
      await insert(record)
      expect(await ctx.store.find(ctx.b.environmentId, record.id)).toBeNull()
      expect(await ctx.store.list(ctx.b.environmentId, org)).toEqual([])
      expect(await ctx.store.findActiveByDomain(ctx.b.environmentId, 'acme.test')).toBeNull()
    })

    test('another environment cannot update or delete a connection, nor touch its domains (H-236)', async () => {
      const record = connection(ctx.a, org)
      await insert(record)
      const outcome = await ctx.store.update(
        ctx.b.environmentId,
        record.id,
        { domains: [] },
        later,
        activity(ctx.b, 'sso_connection.updated', record.id)
      )
      expect(outcome).toBe('missing')
      expect(
        await ctx.store.delete(
          ctx.b.environmentId,
          record.id,
          activity(ctx.b, 'sso_connection.deleted', record.id)
        )
      ).toBe('missing')
      expect((await ctx.store.find(ctx.a.environmentId, record.id))?.domains).not.toEqual([])
    })

    test('a name is one per organization', async () => {
      await insert(connection(ctx.a, org))
      expect(await insert(connection(ctx.a, org, { domains: [] }))).toBe('name_taken')
      const other = await ctx.organization(ctx.a)
      expect(await insert(connection(ctx.a, other))).toMatchObject({ name: 'Okta' })
      expect(await ctx.recorded()).toEqual(['sso_connection.created', 'sso_connection.created'])
    })

    test('drafts may share a domain, two active connections may not', async () => {
      const first = connection(ctx.a, org, { status: 'active' })
      expect(await insert(first)).toMatchObject({ status: 'active' })
      expect(await insert(connection(ctx.a, org, { name: 'Draft' }))).toMatchObject({
        status: 'draft',
      })
      expect(await insert(connection(ctx.a, org, { name: 'Second', status: 'active' }))).toBe(
        'domain_taken'
      )
      expect(await ctx.recorded()).toEqual(['sso_connection.created', 'sso_connection.created'])
    })

    test('activating onto an active connection’s domain is refused, and writes nothing', async () => {
      await insert(connection(ctx.a, org, { status: 'active' }))
      const draft = connection(ctx.a, org, { name: 'Draft' })
      await insert(draft)
      expect(await update(draft.id, { status: 'active' })).toBe('domain_taken')
      expect((await ctx.store.find(ctx.a.environmentId, draft.id))?.status).toBe('draft')
      expect(await ctx.recorded()).toEqual(['sso_connection.created', 'sso_connection.created'])
    })

    test('a status change moves the domain between connections', async () => {
      const first = connection(ctx.a, org, { status: 'active' })
      const second = connection(ctx.a, org, { name: 'Second' })
      await insert(first)
      await insert(second)
      expect((await ctx.store.findActiveByDomain(ctx.a.environmentId, 'acme.test'))?.id).toBe(
        first.id
      )
      expect(await update(first.id, { status: 'disabled' })).toMatchObject({ status: 'disabled' })
      expect(await ctx.store.findActiveByDomain(ctx.a.environmentId, 'acme.test')).toBeNull()
      expect(await update(second.id, { status: 'active' })).toMatchObject({ status: 'active' })
      expect((await ctx.store.findActiveByDomain(ctx.a.environmentId, 'acme.test'))?.id).toBe(
        second.id
      )
    })

    test('an update replaces the domains and keeps what it leaves out', async () => {
      const record = connection(ctx.a, org, { status: 'active' })
      await insert(record)
      const updated = await update(record.id, { domains: ['new.test', 'acme2.test'] })
      expect(updated).toEqual({
        ...record,
        domains: ['acme2.test', 'new.test'],
        updatedAt: later,
      })
      expect(await ctx.store.findActiveByDomain(ctx.a.environmentId, 'acme.test')).toBeNull()
      expect(await ctx.store.findActiveByDomain(ctx.a.environmentId, 'new.test')).not.toBeNull()
    })

    test('a test mark is stored by an update and kept by the next one', async () => {
      const record = connection(ctx.a, org)
      await insert(record)
      expect(
        (await update(record.id, { testedFingerprint: 'abc' })) as SsoConnectionRecord
      ).toMatchObject({
        testedFingerprint: 'abc',
      })
      expect(await update(record.id, { name: 'Renamed' })).toMatchObject({
        testedFingerprint: 'abc',
      })
    })

    test('SAML settings round-trip with each certificate expiry, and an update replaces them', async () => {
      const saml = {
        idpEntityId: 'https://idp.example.com/e',
        ssoUrl: 'https://idp.example.com/sso',
        metadataUrl: null,
        certificates: [{ pem: 'PEM-A', notAfter: '2030-01-01T00:00:00.000Z' }],
      }
      const record = connection(ctx.a, org, { protocol: 'saml', saml, clientSecretSealed: '' })
      await insert(record)
      expect((await ctx.store.find(ctx.a.environmentId, record.id))?.saml).toEqual(saml)
      const next = {
        ...saml,
        certificates: [
          ...saml.certificates,
          { pem: 'PEM-B', notAfter: '2031-01-01T00:00:00.000Z' },
        ],
      }
      const updated = await update(record.id, { saml: next })
      expect(updated).toMatchObject({ saml: next })
      expect(await update(record.id, { name: 'Renamed' })).toMatchObject({ saml: next })
    })

    test('enforcement, break-glass role and MFA trust are stored, and a null role clears it', async () => {
      const record = connection(ctx.a, org)
      await insert(record)
      const set = await update(record.id, {
        enforced: true,
        breakGlassRole: 'admin',
        trustIdpMfa: true,
      })
      expect(set).toMatchObject({ enforced: true, breakGlassRole: 'admin', trustIdpMfa: true })
      const cleared = await update(record.id, { breakGlassRole: null })
      expect(cleared).toMatchObject({ enforced: true, breakGlassRole: null, trustIdpMfa: true })
    })

    test('an update refuses a taken name and an unknown connection', async () => {
      await insert(connection(ctx.a, org))
      const other = connection(ctx.a, org, { name: 'Other', domains: [] })
      await insert(other)
      expect(await update(other.id, { name: 'Okta' })).toBe('name_taken')
      expect(await update(Bun.randomUUIDv7(), { name: 'x' })).toBe('missing')
    })

    test('findActiveByDomain ignores drafts and disabled connections', async () => {
      const draft = connection(ctx.a, org)
      await insert(draft)
      expect(await ctx.store.findActiveByDomain(ctx.a.environmentId, 'acme.test')).toBeNull()
      await update(draft.id, { status: 'active' })
      await update(draft.id, { status: 'disabled' })
      expect(await ctx.store.findActiveByDomain(ctx.a.environmentId, 'acme.test')).toBeNull()
    })

    test('returned records are copies', async () => {
      const record = connection(ctx.a, org)
      await insert(record)
      const read = await ctx.store.find(ctx.a.environmentId, record.id)
      read?.domains.push('mutated.test')
      expect((await ctx.store.find(ctx.a.environmentId, record.id))?.domains).toEqual(['acme.test'])
    })

    test('delete removes an unused connection and records it once', async () => {
      const record = connection(ctx.a, org)
      await insert(record)
      const gone = activity(ctx.a, 'sso_connection.deleted', record.id)
      expect(await ctx.store.delete(ctx.a.environmentId, record.id, gone)).toBe('deleted')
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toBeNull()
      expect(await ctx.store.delete(ctx.a.environmentId, record.id, gone)).toBe('missing')
      expect(await ctx.recorded()).toEqual(['sso_connection.created', 'sso_connection.deleted'])
    })

    test('delete refuses an active connection and changes nothing', async () => {
      const record = connection(ctx.a, org, { status: 'active' })
      await insert(record)
      const gone = activity(ctx.a, 'sso_connection.deleted', record.id)
      expect(await ctx.store.delete(ctx.a.environmentId, record.id, gone)).toBe('in_use')
      expect((await ctx.store.find(ctx.a.environmentId, record.id))?.status).toBe('active')
      expect(await ctx.recorded()).toEqual(['sso_connection.created'])
    })

    test('a connection with an identity is deleted with it', async () => {
      const record = connection(ctx.a, org, { status: 'active' })
      await insert(record)
      const userId = await ctx.user(ctx.a)
      expect(
        await ctx.store.linkIdentity(
          ctx.a.environmentId,
          { connectionId: record.id, userId, subject: 'sub-1' },
          now,
          linked(ctx.a, userId, record.id)
        )
      ).toBe(true)
      expect(await ctx.recorded()).toEqual(['sso_connection.created', 'user.sso_linked'])
      expect(await update(record.id, { status: 'disabled' })).toMatchObject({ status: 'disabled' })
      const attempt = activity(ctx.a, 'sso_connection.deleted', record.id)
      expect(await ctx.store.delete(ctx.a.environmentId, record.id, attempt)).toBe('deleted')
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toBeNull()
      expect(await ctx.store.findIdentity(ctx.a.environmentId, record.id, 'sub-1')).toBeNull()
      expect(await ctx.recorded()).toEqual([
        'sso_connection.created',
        'user.sso_linked',
        'sso_connection.updated',
        'sso_connection.deleted',
      ])
    })

    test('an identity is one per subject and one per user at a connection', async () => {
      const record = connection(ctx.a, org, { status: 'active' })
      await insert(record)
      const one = await ctx.user(ctx.a)
      const two = await ctx.user(ctx.a)
      const link = (userId: string, subject: string) =>
        ctx.store.linkIdentity(
          ctx.a.environmentId,
          { connectionId: record.id, userId, subject },
          now,
          linked(ctx.a, userId, record.id)
        )
      expect(await link(one, 'sub-1')).toBe(true)
      expect(await link(two, 'sub-1')).toBe(false)
      expect(await link(one, 'sub-2')).toBe(false)
      expect(await link(two, 'sub-2')).toBe(true)
      // Only the two links that were stored are recorded.
      expect((await ctx.recorded()).filter((type) => type === 'user.sso_linked')).toHaveLength(2)
      expect(await ctx.store.findIdentity(ctx.a.environmentId, record.id, 'sub-1')).toEqual({
        connectionId: record.id,
        userId: one,
        subject: 'sub-1',
      })
      expect(await ctx.store.findIdentity(ctx.a.environmentId, record.id, 'nope')).toBeNull()
      expect(await ctx.store.findIdentity(ctx.b.environmentId, record.id, 'sub-1')).toBeNull()
    })

    test('an identity cannot be linked to another environment’s connection', async () => {
      const record = connection(ctx.a, org, { status: 'active' })
      await insert(record)
      const userId = await ctx.user(ctx.b)
      expect(
        await ctx.store.linkIdentity(
          ctx.b.environmentId,
          { connectionId: record.id, userId, subject: 'sub-1' },
          now,
          linked(ctx.b, userId, record.id)
        )
      ).toBe(false)
    })

    test('an attribute mapping is stored and changed with the connection', async () => {
      const record = connection(ctx.a, org, { attributeMapping: { idp: 'okta', groups: 'roles' } })
      expect(((await insert(record)) as SsoConnectionRecord).attributeMapping).toEqual({
        idp: 'okta',
        groups: 'roles',
      })
      const changed = (await update(record.id, {
        attributeMapping: { idp: 'entra' },
      })) as SsoConnectionRecord
      expect(changed.attributeMapping).toEqual({ idp: 'entra' })
    })

    test('an organization’s group roles are replaced whole and kept in order', async () => {
      const mappings = [
        { group: 'Admins', role: 'admin' },
        { group: 'Everyone', role: 'member' },
      ]
      const write = (list: typeof mappings) =>
        ctx.store.replaceGroupRoles(
          { ...ctx.a, organizationId: org, mappings: list },
          later,
          activity(ctx.a, 'sso_connection.updated', org)
        )
      expect(await ctx.store.listGroupRoles(ctx.a.environmentId, org)).toEqual([])
      await write(mappings)
      expect(await ctx.store.listGroupRoles(ctx.a.environmentId, org)).toEqual(mappings)
      expect(await ctx.store.listGroupRoles(ctx.b.environmentId, org)).toEqual([])
      const member = { group: 'Everyone', role: 'member' }
      await write([member])
      expect(await ctx.store.listGroupRoles(ctx.a.environmentId, org)).toEqual([member])
    })

    test('deleting the organization removes its connections, identities and group roles', async () => {
      const record = connection(ctx.a, org, { status: 'active' })
      await insert(record)
      const userId = await ctx.user(ctx.a)
      await ctx.store.linkIdentity(
        ctx.a.environmentId,
        { connectionId: record.id, userId, subject: 'sub-1' },
        now,
        linked(ctx.a, userId, record.id)
      )
      await ctx.store.replaceGroupRoles(
        { ...ctx.a, organizationId: org, mappings: [{ group: 'Admins', role: 'admin' }] },
        later,
        activity(ctx.a, 'sso_connection.updated', org)
      )
      await ctx.deleteOrganization(ctx.a, org)
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toBeNull()
      expect(await ctx.store.findIdentity(ctx.a.environmentId, record.id, 'sub-1')).toBeNull()
      expect(await ctx.store.listGroupRoles(ctx.a.environmentId, org)).toEqual([])
    })
  })
}
