import { describeFlowAttemptStore } from '~/adapters/flow-attempt-store.suite'
import { MemoryFlowAttemptStore } from '~/adapters/memory/flow-attempts'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
  user: async () => Bun.randomUUIDv7(),
})

describeFlowAttemptStore('MemoryFlowAttemptStore', async () => ({
  store: new MemoryFlowAttemptStore(),
  a: tenant('00000000-0000-7000-8000-00000000e001'),
  b: tenant('00000000-0000-7000-8000-00000000e002'),
}))
