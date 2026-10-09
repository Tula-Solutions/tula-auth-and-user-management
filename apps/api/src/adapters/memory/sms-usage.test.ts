import { MemorySmsUsageStore } from '~/adapters/memory/sms-usage'
import { describeSmsUsageStore } from '~/adapters/sms-usage-store.suite'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeSmsUsageStore('Memory', async () => ({
  store: new MemorySmsUsageStore(),
  a: tenant('00000000-0000-7000-8000-00000000e001'),
  b: tenant('00000000-0000-7000-8000-00000000e002'),
}))
