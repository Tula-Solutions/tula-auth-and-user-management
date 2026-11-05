import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// TULA-157, H-037: `Outbound.request` is the guard that is enforced at call time and
// `Outbound.check` only advises when an address is saved, so a bare `fetch` in an SSO module
// would reach an operator-typed address with no SSRF check at all.
describe('SSO modules call operator addresses only through Outbound', () => {
  for (const dir of ['sso', 'sso-connection']) {
    test(`${dir} has no bare fetch`, async () => {
      const found: string[] = []
      for await (const file of new Bun.Glob('*.ts').scan(join(import.meta.dir, '..', dir))) {
        if (file.endsWith('.test.ts')) {
          continue
        }
        const text = await Bun.file(join(import.meta.dir, '..', dir, file)).text()
        const code = text
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n')
        if (/(^|[^\w.])(globalThis\.)?fetch\s*\(/.test(code)) {
          found.push(file)
        }
      }
      expect(found).toEqual([])
    })
  }
})
