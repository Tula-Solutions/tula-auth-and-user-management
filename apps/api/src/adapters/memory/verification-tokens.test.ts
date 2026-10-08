import { MemoryVerificationTokenStore } from '~/adapters/memory/verification-tokens'
import { describeVerificationTokenStore } from '~/adapters/verification-token-store.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
  flowAttempt: async () => Bun.randomUUIDv7(),
  user: async () => Bun.randomUUIDv7(),
})

describeVerificationTokenStore('MemoryVerificationTokenStore', async () => ({
  store: new MemoryVerificationTokenStore(),
  a: tenant('00000000-0000-7000-8000-00000000e001'),
  b: tenant('00000000-0000-7000-8000-00000000e002'),
}))
