import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryNativeAppStore } from '~/adapters/memory/native-apps'
import { describeNativeAppStore } from '~/adapters/native-app-store.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeNativeAppStore('Memory', async () => {
  const log = new MemoryActivityLog()
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    store: new MemoryNativeAppStore(log),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})
