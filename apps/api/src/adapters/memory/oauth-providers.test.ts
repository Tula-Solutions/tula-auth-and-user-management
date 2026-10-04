import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryOAuthProviderStore } from '~/adapters/memory/oauth-providers'
import { describeOAuthProviderStore } from '~/adapters/oauth-provider-store.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeOAuthProviderStore('MemoryOAuthProviderStore', async () => {
  const log = new MemoryActivityLog()
  return {
    store: new MemoryOAuthProviderStore(log),
    recorded: async () => log.entries.map((entry) => entry.type),
    a: tenant('00000000-0000-7000-8000-00000000e001'),
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
