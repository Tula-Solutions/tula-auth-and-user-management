import { describe, expect, test } from 'bun:test'

const source = await Bun.file(`${import.meta.dir}/portal.ts`).text()
const handlers = source.split(/^export async function /m).slice(1)

describe('setup portal ownership (TULA-168, H-018)', () => {
  test('every handler that takes a connection id checks it against the link’s organization', () => {
    const withId = handlers.filter((h) => /\n {2}id: string,?\n/.test(h))
    // A new handler that takes an id and forgets requireOwn would let a link reach another
    // organization's connection; this fails it before a route test could notice.
    expect(withId.length).toBe(7)
    for (const h of withId) {
      expect([h.split('(')[0], /await requireOwn\(deps, tenant, scope, id\)/.test(h)]).toEqual([
        h.split('(')[0],
        true,
      ])
    }
  })
})
