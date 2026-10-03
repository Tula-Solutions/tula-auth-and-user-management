import { describeJobLock } from '~/adapters/job-lock.suite'
import { MemoryJobLock } from '~/adapters/memory/job-lock'

describeJobLock('MemoryJobLock', async () => {
  // One object shared by both "instances", as two processes share one database.
  const lock = new MemoryJobLock()
  return { first: lock, second: lock }
})
