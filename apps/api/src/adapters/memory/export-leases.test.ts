import { describeExportLeases } from '~/adapters/export-leases.suite'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryExportLeases } from '~/adapters/memory/export-leases'

describeExportLeases('memory', async () => {
  const clock = new FixedClock()
  const leases = new MemoryExportLeases(clock)
  return { clock, leases, peer: leases, movesTime: true }
})
