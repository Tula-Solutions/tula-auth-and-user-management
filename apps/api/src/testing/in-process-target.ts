import { smsCodeIn, type Target } from '@tula/conformance'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import * as Notices from '~/modules/notice/service'
import * as Sms from '~/modules/sms/service'
import * as Webhooks from '~/modules/webhook/service'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const PUBLISHABLE_KEY = 'tula_pk_dev_conformance00000000000000000000'
const SECRET_KEY = 'tula_sk_dev_conformance00000000000000000000'
/** A subject that leads with a 6-digit code, as every code email's does. */
const CODE_SUBJECT = /^(\d{6})\b/
/** A sign-in link as it appears in an email's text: a URL with the link token in its fragment. */
const EMAIL_LINK = /https?:\/\/\S+#\S*tula_link=\S+/

/**
 * A fresh in-process server to run a conformance scenario against: memory adapters, a clock
 * that `wait` steps advance, and the outboxes the email and SMS steps read. The requests are the same
 * ones `bun run conformance` sends to a live server.
 *
 * Test support: used by `conformance.test.ts` and by `event-canary.test.ts`, which runs the
 * same scenarios to look at what they record.
 *
 * @returns The target, with the `deps` behind it for a test to inspect.
 */
export async function inProcessTarget(): Promise<Target & { deps: TestDeps }> {
  // The runner gives each scenario its own client address through X-Forwarded-For.
  // The OAuth scenarios need a provider that answers without a network: the mock provider, wired
  // as `container.ts` wires it for `OAUTH_MOCK_PROVIDER=true`.
  const deps = createTestDeps({ config: { ...TEST_CONFIG, trustProxy: true, oauthMock: true } })
  Object.assign(deps, {
    oauth: mockOAuthProviders({
      secretBox: deps.secretBox,
      clock: deps.clock,
      publicUrl: deps.config.publicUrl,
    }),
  })
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PUBLISHABLE_KEY)
  await seedApiKey(deps, SECRET_KEY)
  const app = createApp(deps)
  // A second instance of the same deployment: its own app over the same stores, as two
  // processes share one Postgres and one Redis. `multi-instance.test.ts` covers the Redis
  // adapters themselves; here the point is that the shared scenario runs in process too.
  const second = createApp(deps)
  return {
    baseUrl: 'http://tula.test',
    publishableKey: PUBLISHABLE_KEY,
    secretKey: SECRET_KEY,
    fetch: async (request) => app.request(request),
    second: {
      baseUrl: 'http://second.tula.test',
      fetch: async (request) => second.request(request),
    },
    emailCode: async (to) => {
      // The newest email that carries a code: a security notice (ADR 0023) can follow it.
      const message = deps.mailer.outbox.findLast(
        (sent) => sent.to === to && CODE_SUBJECT.test(sent.subject)
      )
      const code = CODE_SUBJECT.exec(message?.subject ?? '')?.[1]
      if (!code) {
        throw new Error(`no email with a code was sent to ${to}`)
      }
      return code
    },
    emailLink: async (to) => {
      // The link travels in the email that carries the code.
      const message = deps.mailer.outbox.findLast(
        (sent) => sent.to === to && CODE_SUBJECT.test(sent.subject)
      )
      const link = EMAIL_LINK.exec(message?.text ?? '')?.[0]
      if (!link) {
        throw new Error(`no email with a link was sent to ${to}`)
      }
      return link
    },
    emailMessage: async (to, subjectContains) => {
      // A security notice is sent after its request was answered (ADR 0023): wait for it.
      await Notices.settled()
      const message = deps.mailer.outbox.findLast(
        (sent) => sent.to === to && sent.subject.includes(subjectContains)
      )
      if (!message) {
        throw new Error(`no email with that subject was sent to ${to}`)
      }
      return { subject: message.subject, text: message.text }
    },
    smsCode: async (to) => {
      // A sign-in's message is sent, and its code stored, after the request was answered.
      await Sms.settled()
      // The memory sender is the inbox here: no route is involved, as for the emails.
      const code = smsCodeIn(deps.sms.messages(to).at(-1)?.text ?? '')
      if (!code) {
        throw new Error('no text message with a code was sent to that number')
      }
      return code
    },
    wait: async (ms) => {
      deps.clock.advance(ms)
    },
    // Authenticator codes are computed for the clock the server reads, not the wall clock.
    now: () => deps.clock.now().getTime(),
    // A webhook receiver is a listener on loopback, which the `local` tier's outbound guard
    // allows; no timer runs here, so a `webhook` step asks for a round of the real worker.
    webhooks: {
      hostname: '127.0.0.1',
      deliver: async () => {
        await Webhooks.run(deps)
      },
    },
    deps,
  }
}
