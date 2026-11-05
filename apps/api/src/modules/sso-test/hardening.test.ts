import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'

/**
 * H-019: `serverBuilt` skips the environment's redirect-URL list, so it may only be set where the
 * address is the server's own. Pinned by reading the sources: a new caller that passes it fails here.
 */
describe('SsoTests.start serverBuilt (H-019)', () => {
  test('only the setup portal and the admin route with no address sent pass it', async () => {
    const root = `${import.meta.dir}/../..`
    const callers: Record<string, string> = {}
    for await (const file of new Glob('**/*.ts').scan(root)) {
      if (file.endsWith('.test.ts')) {
        continue
      }
      const text = await Bun.file(`${root}/${file}`).text()
      // The call's arguments, up to the closing paren at the call's own depth.
      const at = text.indexOf('SsoTests.start(')
      if (at === -1) {
        continue
      }
      let depth = 0
      let end = at + 'SsoTests.start'.length
      for (; end < text.length; end++) {
        if (text[end] === '(') {
          depth++
        } else if (text[end] === ')' && --depth === 0) {
          break
        }
      }
      const args = text.slice(at + 'SsoTests.start('.length, end)
      callers[file] = args.replace(/\s+/g, ' ').trim()
    }
    const passing = Object.entries(callers)
      .filter(([, args]) => args.split(',').length > 5 && !/,\s*$/.test(args))
      .map(([file, args]) => [file, args.split(',').slice(5).join(',').trim()])
    expect(Object.fromEntries(passing)).toEqual({
      'modules/setup-link/portal.ts': 'true',
      'modules/sso-connection/router.ts': 'redirectUrl === undefined',
    })
  })
})
