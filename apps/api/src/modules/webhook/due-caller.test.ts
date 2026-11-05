import { expect, test } from 'bun:test'
import { Glob } from 'bun'

// H-235: `webhookDeliveries.due()` has no claim column. Only one sender at a time is safe because the
// one caller, `Webhooks.run`, holds the `webhook_delivery` job lock for the whole round
// (ADR 0034). A second caller would double-send: add a lease or SKIP LOCKED first.
test('Webhooks.run is the only non-test caller of webhookDeliveries.due', async () => {
  const callers: string[] = []
  for await (const file of new Glob('**/*.ts').scan({ cwd: `${import.meta.dir}/../..` })) {
    if (/\.(test|integration|suite)\.ts$/.test(file) || file.startsWith('adapters/')) {
      continue
    }
    const text = await Bun.file(`${import.meta.dir}/../../${file}`).text()
    if (/\.webhookDeliveries\.due\(/.test(text)) {
      callers.push(file)
    }
  }
  expect(callers).toEqual(['modules/webhook/service.ts'])
})
