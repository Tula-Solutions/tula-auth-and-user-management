import { afterAll, expect, test } from 'bun:test'
import { environmentSettings, events, flowAttempts, proposals, withTenant } from '@tula/db'
import { eq, sql } from 'drizzle-orm'
import { describeActivityLog } from '~/adapters/activity-log.suite'
import { describeEnvironmentSettingsStore } from '~/adapters/environment-settings-store.suite'
import { describeFactorStore } from '~/adapters/factor-store.suite'
import { describeFlowAttemptStore } from '~/adapters/flow-attempt-store.suite'
import { describeHookStore } from '~/adapters/hook-store.suite'
import { describeNativeAppStore } from '~/adapters/native-app-store.suite'
import { describeOAuthProviderStore } from '~/adapters/oauth-provider-store.suite'
import { describePasskeyStore } from '~/adapters/passkey-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { PostgresEnvironmentSettingsStore } from '~/adapters/postgres/environment-settings'
import { PostgresFactorStore } from '~/adapters/postgres/factors'
import { PostgresFlowAttemptStore } from '~/adapters/postgres/flow-attempts'
import { PostgresHookStore } from '~/adapters/postgres/hooks'
import {
  type IntegrationTenant,
  openIntegrationDatabase,
} from '~/adapters/postgres/integration-support'
import { PostgresNativeAppStore } from '~/adapters/postgres/native-apps'
import { PostgresOAuthProviderStore } from '~/adapters/postgres/oauth-providers'
import { PostgresPasskeyStore } from '~/adapters/postgres/passkeys'
import { PostgresProposalStore } from '~/adapters/postgres/proposals'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { PostgresWebhookDeliveryStore } from '~/adapters/postgres/webhook-deliveries'
import { PostgresWebhookEndpointStore } from '~/adapters/postgres/webhook-endpoints'
import { describeProposalStore } from '~/adapters/proposal-store.suite'
import { describeSessionStore } from '~/adapters/session-store.suite'
import { describeUserRepository } from '~/adapters/user-repository.suite'
import { describeVerificationTokenStore } from '~/adapters/verification-token-store.suite'
import { describeWebhookStores } from '~/adapters/webhook-store.suite'
import * as Audit from '~/modules/audit/service'
import type { NewProposalRecord } from '~/ports/proposal-store'

/**
 * The stores' behaviour suites against a real Postgres server, over a pool of several
 * connections as the runtime login.
 *
 * `bun test` runs the same suites on PGlite, which is one session: every "concurrent" call
 * there takes its turn on a single connection. Here the calls a suite starts together run on
 * separate sessions, so row locks, `ON CONFLICT` waits and READ COMMITTED snapshots are the
 * server's own. The control-plane suite is left out: it counts every workspace of the
 * deployment, so it needs a database of its own.
 *
 * Uses the database of `docker compose up -d`. Everything is created under tenants of its own
 * and removed afterwards.
 */
const database = openIntegrationDatabase()
const { db } = database.first

afterAll(() => database.close())

let shared: Promise<{ a: IntegrationTenant; b: IntegrationTenant }> | undefined

/** The two tenants most suites share: made once, on first use. */
function tenants(): Promise<{ a: IntegrationTenant; b: IntegrationTenant }> {
  shared ??= (async () => ({
    a: await database.tenant(),
    b: await database.tenant('production'),
  }))()
  return shared
}

const log = new PostgresActivityLog(db)

describeUserRepository('PostgresUserRepository on a real server', async () => ({
  users: new PostgresUserRepository(db),
  factors: new PostgresFactorStore(db),
  passkeys: new PostgresPasskeyStore(db),
  log,
  ...(await tenants()),
}))

describeSessionStore('PostgresSessionStore on a real server', async () => ({
  store: new PostgresSessionStore(db),
  log,
  ...(await tenants()),
}))

describeFactorStore('PostgresFactorStore on a real server', async () => ({
  store: new PostgresFactorStore(db),
  log,
  ...(await tenants()),
}))

describeFlowAttemptStore('PostgresFlowAttemptStore on a real server', async () => ({
  store: new PostgresFlowAttemptStore(db),
  ...(await tenants()),
}))

describePasskeyStore('PostgresPasskeyStore on a real server', async () => ({
  store: new PostgresPasskeyStore(db),
  log,
  ...(await tenants()),
}))

/** A tenant that can also make the flow attempt a verification token belongs to. */
function withFlowAttempt(tenant: IntegrationTenant) {
  return {
    ...tenant,
    flowAttempt: () =>
      withTenant(db, tenant.environmentId, async (tx) => {
        const id = Bun.randomUUIDv7()
        await tx.insert(flowAttempts).values({
          id,
          projectId: tenant.projectId,
          environmentId: tenant.environmentId,
          kind: 'sign_up',
          status: 'needs_email_verification',
          identifier: 'maya@northline.app',
          expiresAt: new Date('2026-01-01T00:10:00Z'),
        })
        return id
      }),
  }
}

describeVerificationTokenStore('PostgresVerificationTokenStore on a real server', async () => {
  const { a, b } = await tenants()
  return {
    store: new PostgresVerificationTokenStore(db),
    a: withFlowAttempt(a),
    b: withFlowAttempt(b),
  }
})

// Fresh tenants per test: these suites count rows per environment.
describeOAuthProviderStore('PostgresOAuthProviderStore on a real server', async () => {
  const [a, b] = [await database.tenant(), await database.tenant('production')]
  return {
    store: new PostgresOAuthProviderStore(db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    a,
    b,
  }
})

// Fresh tenants per test: an environment has one hook per point, and on a real server two
// registrations at once meet at the unique index.
describeHookStore('Postgres on a real server', async () => {
  const [a, b] = [await database.tenant(), await database.tenant('production')]
  return {
    store: new PostgresHookStore(db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

// Fresh tenants per test: an environment has one app per platform and identifier, and on a
// real server two registrations at once meet at the unique index.
describeNativeAppStore('Postgres on a real server', async () => {
  const [a, b] = [await database.tenant(), await database.tenant('production')]
  return {
    store: new PostgresNativeAppStore(db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

// Fresh tenants per test, for the same reason. On a real server the duplicate delivery of one
// endpoint and event is a wait on the unique index, and the insert for an endpoint that was
// just removed is the foreign key's own refusal.
describeWebhookStores('Postgres on a real server', async () => {
  const [a, b] = [await database.tenant(), await database.tenant('production')]
  return {
    endpoints: new PostgresWebhookEndpointStore(db),
    deliveries: new PostgresWebhookDeliveryStore(db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    seedEvent: async (tenant, event) => {
      const id = Bun.randomUUIDv7()
      await withTenant(db, tenant.environmentId, (tx) =>
        tx.insert(events).values({
          id,
          projectId: tenant.projectId,
          environmentId: tenant.environmentId,
          ...event,
        })
      )
      return id
    },
    deliveredAt: async (tenant, eventId) => {
      const [row] = await withTenant(db, tenant.environmentId, (tx) =>
        tx.select({ deliveredAt: events.deliveredAt }).from(events).where(eq(events.id, eventId))
      )
      return row?.deliveredAt ?? null
    },
    eventExists: async (tenant, eventId) =>
      (
        await withTenant(db, tenant.environmentId, (tx) =>
          tx.select({ id: events.id }).from(events).where(eq(events.id, eventId))
        )
      ).length === 1,
    // The two ids and nothing else: the suite spreads a tenant into the records it expects
    // back, and this fixture's tenant also carries helpers (`user`) no stored row has.
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

describeEnvironmentSettingsStore('PostgresEnvironmentSettingsStore on a real server', async () => ({
  store: new PostgresEnvironmentSettingsStore(db),
  log,
  freshTenant: () => database.tenant(),
  storeDocument: async (tenant, settings) => {
    await withTenant(db, tenant.environmentId, (tx) =>
      tx.insert(environmentSettings).values({
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        // The column is free-form JSON: a document need not be an object.
        settings: settings as Record<string, unknown>,
      })
    )
  },
  storeManager: async (tenant, manager) => {
    await withTenant(db, tenant.environmentId, (tx) =>
      tx
        .update(environmentSettings)
        .set({ managedBy: manager as Record<string, unknown> })
        .where(eq(environmentSettings.environmentId, tenant.environmentId))
    )
  },
}))

describeActivityLog('Postgres stores on a real server', async () => ({
  log,
  sessions: new PostgresSessionStore(db),
  users: new PostgresUserRepository(db),
  apiKeys: new PostgresApiKeyRepository(db),
  signingKeys: new PostgresSigningKeyStore(db),
  ...(await tenants()),
  freshTenant: () => database.tenant(),
}))

/** Store an unrevoked API key of a tenant, as a fixture, and answer its id. */
async function seedKey(
  owner: { projectId: string; environmentId: string },
  kind: 'agent' | 'secret'
): Promise<string> {
  const id = Bun.randomUUIDv7()
  await new PostgresApiKeyRepository(db).insert(
    {
      id,
      kind,
      name: 'suite',
      projectId: owner.projectId,
      environmentId: owner.environmentId,
      // Unique per key: the id is as good a stand-in for a hash as any.
      keyHash: id,
      lastFour: '0000',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    Audit.none('fixture')
  )
  return id
}

// Fresh tenants per test: the suite lists and counts an environment's proposals. Here the
// condition "the key that asked is still an agent key" is the server's own subquery, read by
// the runtime login under row-level security.
describeProposalStore('Postgres on a real server', async () => {
  const [a, b] = [await database.tenant(), await database.tenant('production')]
  const keys = new PostgresApiKeyRepository(db)
  return {
    store: new PostgresProposalStore(db),
    key: seedKey,
    revokeKey: async (owner, id) => {
      await keys.revoke(owner.environmentId, id, new Date(), Audit.none('fixture'))
    },
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

/** A pending proposal of a tenant, asked for by `proposedBy`. */
function pendingProposal(
  owner: { projectId: string; environmentId: string },
  proposedBy: string
): NewProposalRecord {
  const at = new Date('2026-01-01T00:00:00.000Z')
  return {
    id: Bun.randomUUIDv7(),
    projectId: owner.projectId,
    environmentId: owner.environmentId,
    operation: 'ban_user',
    targetType: 'user',
    targetId: Bun.randomUUIDv7(),
    proposedBy,
    status: 'pending',
    expiresAt: new Date('2026-01-01T00:10:00.000Z'),
    approvedByType: null,
    approvedById: null,
    approvedAt: null,
    failureReason: null,
    createdAt: at,
    updatedAt: at,
  }
}

/** The database's own words for why it refused a statement, or `null` when it did not. */
function refusalOf(work: Promise<unknown>): Promise<string | null> {
  return work.then(
    () => null,
    (error: unknown) => {
      const cause = (error as { cause?: { message?: string } }).cause?.message
      return String(cause ?? (error as Error).message)
    }
  )
}

test('proposals on a real server: row-level security hides another environment’s proposal from the runtime login', async () => {
  const [a, b] = [await database.tenant(), await database.tenant()]
  const store = new PostgresProposalStore(db)
  const row = await store.insert(
    pendingProposal(a, await seedKey(a, 'agent')),
    Audit.none('fixture')
  )
  // Through the store, under the other tenant.
  expect(await store.find(b.environmentId, row.id)).toBeNull()
  expect(await store.list(b.environmentId, 50)).toEqual([])
  // And by a direct query: under the other tenant, and with no tenant at all.
  const underB = await withTenant(db, b.environmentId, (tx) =>
    tx.select({ id: proposals.id }).from(proposals).where(eq(proposals.id, row.id))
  )
  expect(underB).toEqual([])
  expect(
    await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.id, row.id))
  ).toEqual([])
  // A write under the other tenant finds no row to change.
  const changed = await withTenant(db, b.environmentId, (tx) =>
    tx
      .update(proposals)
      .set({ status: 'failed', updatedAt: sql`now()` })
      .where(eq(proposals.id, row.id))
      .returning({ id: proposals.id })
  )
  expect(changed).toEqual([])
  expect((await store.find(a.environmentId, row.id))?.status).toBe('pending')
})

test('proposals on a real server: the runtime login cannot rewrite what a proposal would do, to what, for whom or until when', async () => {
  const a = await database.tenant()
  const store = new PostgresProposalStore(db)
  const row = await store.insert(
    pendingProposal(a, await seedKey(a, 'agent')),
    Audit.none('fixture')
  )
  const attempts = [
    { operation: 'delete_user' },
    { targetId: Bun.randomUUIDv7() },
    { targetType: 'session' },
    { proposedBy: Bun.randomUUIDv7() },
    { expiresAt: new Date('2026-01-01T00:59:00.000Z') },
    { createdAt: new Date('2026-01-01T00:05:00.000Z') },
  ]
  for (const set of attempts) {
    const said = await refusalOf(
      withTenant(db, a.environmentId, (tx) =>
        tx.update(proposals).set(set).where(eq(proposals.id, row.id))
      )
    )
    expect(said).toContain('permission denied')
  }
  const after = await store.find(a.environmentId, row.id)
  expect(after).toMatchObject({
    operation: row.operation,
    targetType: row.targetType,
    targetId: row.targetId,
    proposedBy: row.proposedBy,
  })
  expect(after?.expiresAt.toISOString()).toBe(row.expiresAt.toISOString())
  expect(after?.createdAt.toISOString()).toBe(row.createdAt.toISOString())
  // What a decision writes is allowed.
  expect(
    await refusalOf(
      withTenant(db, a.environmentId, (tx) =>
        tx.update(proposals).set({ updatedAt: sql`now()` }).where(eq(proposals.id, row.id))
      )
    )
  ).toBeNull()
})
