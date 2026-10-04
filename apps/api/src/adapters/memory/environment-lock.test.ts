import { describeEnvironmentLock } from '~/adapters/environment-lock.suite'
import { MemoryEnvironmentLock } from '~/adapters/memory/environment-lock'

describeEnvironmentLock('MemoryEnvironmentLock', async () => {
  // One object shared by both "instances", as two processes share one database.
  const lock = new MemoryEnvironmentLock()
  return { first: lock, second: lock }
})
