import { describe, expect, test } from 'bun:test'
import { loadScenarios, runScenario, type Scenario, type Target } from '@tula/conformance'
import { TulaEventSchema } from '@tula/contract'
import { z } from 'zod'
import { inProcessTarget } from '~/testing/in-process-target'

// The canary test of the event payloads (ADR 0012): an event goes to a third party, so nothing
// a client or an admin typed, and nothing the server handed out as a secret, may be in one.
//
// Every conformance scenario is run against the real API in process, with two changes:
//
//   - every generated address, password and GUID is a recognisable canary instead;
//   - the wire is tapped: whatever a request carried (body, query, credentials, cookies, user
//     agent, client address), whatever a response handed out as a secret (tokens, attempt
//     secrets, keys, TOTP secrets, backup codes, tickets, cookies) and whatever was emailed
//     (addresses, codes, links) is collected.
//
// Then every recorded event payload, and the details of every audit entry, are searched for
// all of it. What a payload may hold is listed in `@tula/contract`'s event schemas: ids the
// server made, values from closed sets, and the names (never the values) of changed settings.

/**
 * In every canary address, password and GUID; never in anything the server makes. A canary
 * GUID (a Microsoft tenant id or object id, which a provider supplies) ends in twelve fixed
 * hex digits: the tap takes anything GUID-shaped for one of the server's own ids and does not
 * look for it, so the marker is the only thing that finds one.
 */
const MARKERS = /canary|s3cretpass|c0ffeec0ffee/i

/** The same scenario with a canary for every address and password it would generate. */
function withCanaries(scenario: Scenario): Scenario {
  const variables = Object.entries(scenario.variables ?? {}).map(([name, value], index) => {
    if (typeof value === 'string') {
      return [name, value]
    }
    if (value.generate === 'uuid') {
      return [name, `${index.toString(16).padStart(8, '0')}-c0de-4c0d-8c0d-c0ffeec0ffee`]
    }
    return [
      name,
      value.generate === 'email'
        ? `canary-${index}-${name.toLowerCase()}@canary.example`
        : // Upper, lower, digit and symbol, like the runner's own; no part of the address.
          `Tu-S3CRETPASS${index}-x9Kf${name.length}-Zq7!`,
    ]
  })
  return { ...scenario, variables: Object.fromEntries(variables) }
}

/** Every string at any depth of a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings)
  }
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
}

/** The strings under the keys of a response that name something secret, at any depth. */
function secrets(value: unknown, named = false): string[] {
  if (typeof value === 'string') {
    return named ? [value] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => secrets(item, named))
  }
  if (value === null || typeof value !== 'object') {
    return []
  }
  return Object.entries(value).flatMap(([key, child]) =>
    secrets(child, named || SECRET_KEYS.test(key))
  )
}

/** Response fields whose value is a credential, in whole or in part. */
const SECRET_KEYS = /token|secret|^key$|^codes?$|^uri$|binding|ticket|challenge|credential/i

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The values of a query string or a URL fragment written like one. */
function parameters(text: string): string[] {
  return [...new URLSearchParams(text.replace(/^[?#]/, '')).values()]
}

/**
 * What an event payload is allowed to say in words: the values of the closed sets its
 * schemas name (`secret` is a kind of API key and a changed field's name, not a leak).
 */
function vocabulary(): Set<string> {
  const words = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'const' || key === 'enum') {
          for (const word of strings(child)) {
            words.add(word)
          }
        } else {
          walk(child)
        }
      }
    }
  }
  walk(z.toJSONSchema(TulaEventSchema, { unrepresentable: 'any' }))
  return words
}

const VOCABULARY = vocabulary()
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/**
 * The request headers whose value may be found in a payload, and the one field it may be
 * found in. A closed list, and a decision each (ADR 0012); such a value is not a canary, and
 * anywhere but its own field it is a leak like any other ({@link withoutAllowed}).
 *
 * - `x-tula-managed-by`: the name of the tool that applies a config file (ADR 0030),
 *   validated against `CONFIG_TOOL_PATTERN` before it is stored. The one client-supplied
 *   string a payload is meant to carry.
 * - `x-tula-session-profile`: the name of a session profile a client asks for. The header
 *   itself reaches no payload. But a profile's name is a key of the settings document, which
 *   an admin chose, and `changed` lists the names of changed settings: so the same string is
 *   in a payload whenever that profile is added or edited, whether or not any client ever
 *   sent the header. Found by tapping every header; kept here so that it is a recorded
 *   decision and not an accident.
 */
const MAY_APPEAR: Record<string, { type: string; field: string }> = {
  'x-tula-managed-by': { type: 'environment.settings_updated', field: 'managedBy' },
  'x-tula-session-profile': { type: 'environment.settings_updated', field: 'changed' },
}

/** The recorded events without the fields {@link MAY_APPEAR} allows a client's value in. */
function withoutAllowed(
  events: readonly { type: string; data: Record<string, unknown> }[]
): unknown[] {
  return events.map((event) => {
    const data = { ...event.data }
    for (const { type, field } of Object.values(MAY_APPEAR)) {
      if (event.type === type) {
        delete data[field]
      }
    }
    return { ...event, data }
  })
}

/** Everything that crossed the wire and must not be in an event. */
class Tap {
  readonly inputs = new Set<string>()
  /** Values of the {@link MAY_APPEAR} headers: allowed in their own field, and only there. */
  readonly mayAppear = new Set<string>()
  /** `METHOD /path` of every request, for the test that says which flows were exercised. */
  readonly requests = new Set<string>()

  /** An input, unless it is an id (ids are what events are made of) or a contract word. */
  add(value: string | null | undefined): void {
    if (value && !UUID.test(value) && !VOCABULARY.has(value)) {
      this.inputs.add(value)
    }
  }

  addAll(values: readonly (string | null | undefined)[]): void {
    for (const value of values) {
      this.add(value)
    }
  }

  async request(request: Request): Promise<void> {
    const url = new URL(request.url)
    this.requests.add(`${request.method} ${url.pathname}`)
    this.addAll(parameters(url.search))
    // Every header, not a list of the ones known to matter: a header the API starts reading
    // later is then tapped without anyone remembering to add it here.
    for (const [name, value] of request.headers) {
      if (Object.hasOwn(MAY_APPEAR, name)) {
        this.mayAppear.add(value)
      } else if (name === 'authorization') {
        this.add(value.replace(/^Bearer /, ''))
      } else if (name === 'cookie') {
        this.addAll(value.split(';').map((cookie) => cookie.split('=').slice(1).join('=').trim()))
      } else {
        this.add(value)
      }
    }
    const body = await request.clone().text()
    const json = parseJson(body)
    for (const value of json === undefined ? parameters(body) : strings(json)) {
      this.add(value)
    }
  }

  async response(response: Response): Promise<void> {
    for (const cookie of response.headers.getSetCookie()) {
      this.add(cookie.split(';')[0]?.split('=').slice(1).join('='))
    }
    const location = response.headers.get('location')
    if (location) {
      const { search, hash } = new URL(location, 'http://tula.test')
      for (const value of [...parameters(search), ...parameters(hash)]) {
        this.add(value)
      }
    }
    this.addAll(secrets(parseJson(await response.clone().text())))
  }

  email(message: { to: string; subject: string; text: string }): void {
    this.add(message.to)
    for (const found of `${message.subject}\n${message.text}`.match(/\b\d{6}\b|https?:\/\/\S+/g) ??
      []) {
      this.add(found)
      if (found.includes('#')) {
        this.addAll(parameters(found.slice(found.indexOf('#'))))
      }
    }
  }

  /** The target with every request and response of it (and of its second instance) recorded. */
  around<T extends Target>(target: T): T {
    const through =
      (send: Target['fetch']): Target['fetch'] =>
      async (request) => {
        await this.request(request)
        const response = await send(request)
        await this.response(response)
        return response
      }
    return {
      ...target,
      fetch: through(target.fetch),
      second: target.second && { ...target.second, fetch: through(target.second.fetch) },
    }
  }
}

/**
 * The inputs found in what was recorded. A long input is looked for inside every string; a
 * short one (a 6-digit code) only as a whole value, so that it is not "found" in an id.
 *
 * @returns A description of each leak that names no secret: its length and where it was.
 */
function leaks(recorded: unknown, inputs: ReadonlySet<string>): string[] {
  const found = strings(recorded)
  return [...inputs]
    .filter((input) =>
      found.some((value) => value === input || (input.length >= 8 && value.includes(input)))
    )
    .map((input) => `an input of ${input.length} characters starting ${input.slice(0, 3)}…`)
}

/** Run one scenario with canaries and the wire tapped; return what it recorded and carried. */
async function record(scenario: Scenario) {
  const tap = new Tap()
  const target = await inProcessTarget()
  const result = await runScenario(withCanaries(scenario), tap.around(target))
  for (const message of target.deps.mailer.outbox) {
    tap.email(message)
  }
  const { events, entries } = target.deps.activityLog
  return { tap, result, events, details: entries.map((entry) => entry.data) }
}

const scenarios = await loadScenarios()

describe('event payloads hold nothing a client or admin supplied, and no secret', () => {
  test.each(scenarios.map(({ file, scenario }) => [file, scenario] as const))(
    '%s',
    async (_file, scenario) => {
      const { tap, result, events, details } = await record(scenario)
      // The canaries are valid input: the scenario still passes with them.
      expect(result.status).toBe('passed')
      expect(tap.inputs.size).toBeGreaterThan(0)

      expect(JSON.stringify(events)).not.toMatch(MARKERS)
      expect(leaks(events, tap.inputs)).toEqual([])
      // What a client supplied and a payload is meant to carry is in its own field only.
      expect(leaks(withoutAllowed(events), tap.mayAppear)).toEqual([])
      // The audit entry's details are held to the same rule (its origin columns are not: the
      // IP address and user agent belong to the audit log, and only there).
      expect(JSON.stringify(details)).not.toMatch(MARKERS)
      expect(leaks(details, tap.inputs)).toEqual([])
    }
  )

  // The sweep above proves nothing if the tap is blind or the flows record nothing: this
  // runs the journeys the event contract was written for and says what was seen.
  test('the tap sees the inputs of sign-up, sign-in, reset, admin create, settings and OAuth', async () => {
    const named = [
      'sign-up',
      'sign-in',
      'password reset',
      'email code sign-in',
      'environment settings',
      'OAuth sign-up and sign-in',
    ]
    const runs = await Promise.all(
      named.map((name) => {
        const found = scenarios.find(({ scenario }) => scenario.name === name)
        if (!found) {
          throw new Error(`no scenario named ${name}`)
        }
        return record(found.scenario)
      })
    )
    const requests = new Set(runs.flatMap(({ tap }) => [...tap.requests]))
    for (const request of [
      'POST /v1/client/sign-ups',
      'POST /v1/client/sign-ins',
      'POST /v1/client/password-resets',
      'POST /v1/admin/users',
      'PUT /v1/admin/settings',
      'POST /v1/client/sign-ins/oauth/exchange',
    ]) {
      expect([...requests]).toContain(request)
    }

    const inputs = [...new Set(runs.flatMap(({ tap }) => [...tap.inputs]))]
    for (const kind of [
      /^canary-\d+-\w+@canary\.example$/, // an address
      /^Tu-S3CRETPASS/, // a password
      /^\d{6}$/, // an emailed code
      /^tula-conformance\/1$/, // the user agent
      /^\d{1,3}(\.\d{1,3}){3}$/, // the client's address
      /^Conformance Suite/, // an app name an admin set
      /^tula_sk_/, // the secret key
      /^tula_rt_/, // a refresh token
      /^ey[\w-]+\.[\w-]+\.[\w-]+$/, // an access token
    ]) {
      const input = inputs.find((candidate) => kind.test(candidate))
      expect(input).toBeDefined()
      // And had a payload carried it, in a copy of what was really recorded, the search
      // would have said so.
      const carrying = [...(runs[0]?.events ?? []), { data: { anything: [input] } }]
      expect(leaks(carrying, new Set(inputs))).toHaveLength(1)
    }

    const types = new Set(runs.flatMap(({ events }) => events.map((event) => event.type)))
    for (const type of [
      'user.created',
      'user.email_verified',
      'user.password_changed',
      'session.created',
      'session.revoked',
      'environment.settings_updated',
      'oauth_provider.updated',
    ] as const) {
      expect([...types]).toContain(type)
    }
    for (const { events } of runs) {
      expect(leaks(events, new Set(inputs))).toEqual([])
    }
  })

  test('a leak is found: in a nested value, inside a longer string, or as a whole short one', () => {
    const inputs = new Set(['someone@example.com', '123456', 'tula_rt_abcdefgh'])
    const clean = [{ data: { userId: '00000000-0000-7000-8000-000000123456', reason: 'sign_out' } }]
    expect(leaks(clean, inputs)).toEqual([])
    expect(leaks([{ data: { nested: [{ to: 'someone@example.com' }] } }], inputs)).toHaveLength(1)
    expect(leaks([{ data: { note: 'sent to <someone@example.com>' } }], inputs)).toHaveLength(1)
    expect(leaks([{ data: { code: '123456' } }], inputs)).toHaveLength(1)
    expect(leaks([{ data: { token: 'Bearer tula_rt_abcdefgh' } }], inputs)).toHaveLength(1)
    // And the description of a leak does not repeat it.
    expect(leaks([{ data: { code: '123456' } }], inputs).join()).not.toContain('123456')
  })

  test('ids and the contract’s own words are not inputs', () => {
    const tap = new Tap()
    for (const value of ['00000000-0000-7000-8000-000000000001', 'secret', 'google', 'web']) {
      tap.add(value)
    }
    expect(tap.inputs.size).toBe(0)
    tap.add('hunter2')
    expect([...tap.inputs]).toEqual(['hunter2'])
  })

  // The header list is open: a header the API learns to read tomorrow is tapped today.
  test('every request header is an input, whatever its name', async () => {
    const tap = new Tap()
    await tap.request(
      new Request('http://tula.test/v1/client/config', {
        headers: {
          'x-a-header-nobody-listed': 'hunter2hunter2',
          authorization: 'Bearer tula_sk_dev_abcdefgh',
          cookie: 'tula_rt=first-cookie-value; other=second-cookie-value',
          'x-tula-managed-by': 'some-tool',
        },
      })
    )
    expect([...tap.inputs].sort()).toEqual(
      ['hunter2hunter2', 'tula_sk_dev_abcdefgh', 'first-cookie-value', 'second-cookie-value'].sort()
    )
    // The one header whose value is meant to reach a payload is kept apart, not ignored.
    expect([...tap.mayAppear]).toEqual(['some-tool'])
  })

  test('the managing tool’s name reaches a payload as `managedBy`, and nowhere else', async () => {
    const found = scenarios.find(
      ({ scenario }) => scenario.name === 'settings managed by a config file'
    )
    if (!found) {
      throw new Error('no such scenario')
    }
    const { tap, events } = await record(found.scenario)
    expect([...tap.mayAppear]).toContain('conformance')
    expect(events.map((event) => event.data.managedBy)).toContain('conformance')
    expect(leaks(withoutAllowed(events), tap.mayAppear)).toEqual([])
    // Anywhere else it is a leak like any other.
    const elsewhere = [...events, { type: 'user.created', data: { method: 'conformance' } }]
    expect(leaks(withoutAllowed(elsewhere), tap.mayAppear)).toHaveLength(1)
    const wrongType = [...events, { type: 'user.created', data: { managedBy: 'conformance' } }]
    expect(leaks(withoutAllowed(wrongType), tap.mayAppear)).toHaveLength(1)
  })
})
