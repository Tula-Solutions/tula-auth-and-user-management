import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'

// A phone number finds an account in one place and for one purpose (ADR 0037): the two
// `sms_code` steps of a sign-in, through `Phone.signInHolder`. A number is not unique and is
// never proof of an address, so nothing else may look an account up by one: not a sign-in's
// start, not a sign-up, not account linking, not an admin search.
//
// This walks the server's sources and fails when a new caller appears. A new caller is a
// decision (and a paragraph in the ADR), then a line here.

const SRC = `${import.meta.dir}/../..`

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for await (const path of new Glob('**/*.ts').scan({ cwd: SRC })) {
    if (/\.(test|suite|integration)\.ts$/.test(path) || path.startsWith('testing')) {
      continue
    }
    files.set(path, await Bun.file(`${SRC}/${path}`).text())
  }
  return files
}

/** The files that call `name(`, with how many times each does. */
function callers(files: Map<string, string>, name: string): Record<string, number> {
  const found: Record<string, number> = {}
  for (const [path, text] of files) {
    // A call or a declaration, not a mention in a comment (`findByPhoneNumber(…, 2)` there
    // is written with backticks).
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    const count = code.split(`${name}(`).length - 1
    if (count > 0) {
      found[path] = count
    }
  }
  return found
}

describe('where an account is found from a phone number', () => {
  test('the store’s lookup is called by `Phone.signInHolder` and by nothing else', async () => {
    expect(callers(await sources(), 'findByPhoneNumber')).toEqual({
      // The two adapters and the port declare it.
      'adapters/memory/users.ts': 1,
      'adapters/postgres/users.ts': 1,
      'ports/user-repository.ts': 1,
      // The one caller.
      'modules/phone/service.ts': 1,
    })
  })

  test('`Phone.signInHolder` is called by the two `sms_code` steps of a sign-in only', async () => {
    expect(callers(await sources(), 'signInHolder')).toEqual({
      // Its declaration.
      'modules/phone/service.ts': 1,
      // Asking for the code (does a message go?) and accepting it (still the same user?).
      'modules/flow/service.ts': 2,
    })
  })

  test('no query of the server compares a user’s phone number outside the user store', async () => {
    const files = await sources()
    const comparing = [...files]
      .filter(([, text]) => /users\.phoneNumber\b/.test(text))
      .map(([path]) => path)
    expect(comparing).toEqual(['adapters/postgres/users.ts'])
  })
})
