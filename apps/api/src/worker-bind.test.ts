import { expect, test } from 'bun:test'
import { join } from 'node:path'

// H-207: the health server names the interface it listens on. Pinned on the source because the
// entrypoint cannot be imported (it boots a container); worker.test.ts runs it for real.
test('worker.ts binds its health server with an explicit hostname', async () => {
  const source = await Bun.file(join(import.meta.dir, 'worker.ts')).text()
  const call = /Bun\.serve\(\{([\s\S]*?)\n\}\)/.exec(source)
  expect(call?.[1]).toMatch(/\bhostname:\s*['"]0\.0\.0\.0['"]/)
})
