import { afterAll } from 'bun:test'
import { environmentSettings, events, flowAttempts, withTenant } from '@tula/db'
import { eq } from 'drizzle-orm'
import { describeActivityLog } from '~/adapters/activity-log.suite'
import { describeEnvironmentSettingsStore } from '~/adapters/environment-settings-store.suite'
import { describeFactorStore } from '~/adapters/factor-store.suite'
import { describeFlowAttemptStore } from '~/adapters/flow-attempt-store.suite'
import { describeHookStore } from '~/adapters/hook-store.suite'
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
import { PostgresOAuthProviderStore } from '~/adapters/postgres/oauth-providers'
import { PostgresPasskeyStore } from '~/adapters/postgres/passkeys'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { PostgresWebhookDeliveryStore } from '~/adapters/postgres/webhook-deliveries'
import { PostgresWebhookEndpointStore } from '~/adapters/postgres/webhook-endpoints'
import { describeSessionStore } from '~/adapters/session-store.suite'
import { describeUserRepository } from '~/adapters/user-repository.suite'
import { describeVerificationTokenStore } from '~/adapters/verification-token-store.suite'
import { describeWebhookStores } from '~/adapters/webhook-store.suite'

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
