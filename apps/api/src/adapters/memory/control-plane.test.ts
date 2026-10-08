import { describeControlPlane } from '~/adapters/control-plane.suite'
import { MemoryControlPlane } from '~/adapters/memory/control-plane'
import { MemoryEnvironmentRepository } from '~/adapters/memory/environments'

describeControlPlane(
  'MemoryControlPlane',
  async () => new MemoryControlPlane(new MemoryEnvironmentRepository())
)
