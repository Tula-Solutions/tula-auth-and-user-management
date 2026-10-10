import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  behaviourDecision,
  CLIENT_BEHAVIOURS,
  CLIENT_JOURNEYS_FILE,
  CLIENT_KINDS,
  ClientDecisionSchema,
  type ClientJourneys,
  ClientJourneysSchema,
  type ClientKind,
  clientJourneyListProblems,
  clientSuiteProblems,
  duplicateJsonKeys,
  loadClientJourneys,
  MIN_NOT_APPLICABLE_REASON_LENGTH,
  scenarioDecision,
  testsThatMayNotRun,
} from './client-journeys'
import { loadScenarios } from './load'

const REASON = 'only a server holding the secret key can reach this, never a client SDK.'
const JOURNEY = { decision: 'journey' } as const
const NOT_APPLICABLE = { decision: 'not_applicable', reason: REASON } as const
const UNDECIDED = { decision: 'undecided' } as const

/** A small valid list: one client with a suite, two scenarios, every behaviour a journey. */
function fixture(change: (list: ClientJourneys) => void = () => undefined): ClientJourneys {
  const behaviour = (description: string) => ({ description, clients: { core: JOURNEY } })
  const list: ClientJourneys = {
    clients: {
      core: { description: 'the TypeScript client', suite: 'exists' },
      expo: { description: 'the Expo SDK', suite: 'planned' },
      swift: { description: 'the Swift SDK', suite: 'planned' },
      kotlin: { description: 'the Kotlin SDK', suite: 'planned' },
    },
    scenarios: {
      'admin only': { core: NOT_APPLICABLE },
      'sign-in': { core: JOURNEY },
    },
    behaviours: {
      concurrent_refresh: behaviour('one refresh for many callers'),
      refresh_without_answer: behaviour('one repeat'),
      unknown_step_not_supported: behaviour('not supported'),
      session_kept_through_failed_refresh_offline: behaviour('kept offline'),
    },
  }
  change(list)
  return ClientJourneysSchema.parse(list)
}
const SCENARIOS = ['sign-in', 'admin only']
/** What a suite that agrees with {@link fixture} registered. */
const suite = (journeys: Record<string, string[]> = { 'sign-in': ['signs in'] }) => ({
  journeys: new Map(Object.entries(journeys)),
  behaviours: [...CLIENT_BEHAVIOURS] as string[],
})

describe('the committed list', () => {
  test('the committed JSON Schema is what the Zod schema generates', async () => {
    const committed = await Bun.file(
      join(import.meta.dir, '../../../conformance/client-journeys.schema.json')
    ).json()
    expect(committed).toEqual(
      JSON.parse(JSON.stringify(z.toJSONSchema(ClientJourneysSchema, { io: 'input' })))
    )
  })

  test('loads, names only scenarios that exist, is in order, and leaves nothing undecided for a client whose suite exists', async () => {
    const list = await loadClientJourneys()
    const names = (await loadScenarios()).map(({ scenario }) => scenario.name)
    expect(CLIENT_JOURNEYS_FILE.endsWith('conformance/client-journeys.json')).toBe(true)
    expect(Object.keys(list.scenarios).length).toBeGreaterThanOrEqual(95)
    expect(clientJourneyListProblems(list, names)).toEqual([])
  })

  test('@tula/core has a suite; the clients that are not written yet are planned', async () => {
    const { clients } = await loadClientJourneys()
    expect(clients.core.suite).toBe('exists')
    // A planned client's suite flips this in the change that adds it, and then decides
    // everything: this line changes with it, on purpose.
    expect([clients.expo.suite, clients.swift.suite, clients.kotlin.suite]).toEqual([
      'planned',
      'planned',
      'planned',
    ])
  })
})

describe('the list’s format', () => {
  const directories: string[] = []
  afterAll(() => Promise.all(directories.map((path) => rm(path, { recursive: true }))))
  async function file(text: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'tula-client-journeys-'))
    directories.push(directory)
    const path = join(directory, 'client-journeys.json')
    await Bun.write(path, text)
    return path
  }

  test('a valid file loads', async () => {
    const path = await file(JSON.stringify({ $schema: './x.json', ...fixture() }))
    expect((await loadClientJourneys(path)).scenarios['sign-in']).toEqual({ core: JOURNEY })
  })

  // `JSON.parse` keeps the last of two equal keys and says nothing; a parser in another
  // language may keep the first. A decision written twice is two decisions.
  const text = () => JSON.stringify(fixture(), null, 2)
  test.each([
    [
      'a scenario',
      () =>
        text().replace(
          '"sign-in": {',
          '"sign-in": { "core": { "decision": "undecided" } },\n"sign-in": {'
        ),
      'duplicate key "sign-in" in scenarios',
    ],
    [
      'a scenario, the second spelling with an escape',
      () => text().replace('"sign-in": {', '"sign\\u002din": {},\n"sign-in": {'),
      'duplicate key "sign-in" in scenarios',
    ],
    [
      'a behaviour',
      () =>
        text().replace(
          '"refresh_without_answer": {',
          '"refresh_without_answer": { "description": "x", "clients": {} },\n"refresh_without_answer": {'
        ),
      'duplicate key "refresh_without_answer" in behaviours',
    ],
    [
      'a client inside one entry',
      () => text().replace('"sign-in": {', '"sign-in": { "core": { "decision": "undecided" },'),
      'duplicate key "core" in scenarios.sign-in',
    ],
    [
      'a key of a decision',
      () =>
        text().replace(
          '"decision": "not_applicable",',
          '"decision": "journey", "decision": "not_applicable",'
        ),
      'duplicate key "decision" in scenarios.admin only.core',
    ],
    [
      'a top-level key',
      () => `${text().trimEnd().slice(0, -1)}, "scenarios": {} }`,
      'duplicate key "scenarios" at the top level',
    ],
  ] as [string, () => string, string][])(
    'refuses a file that writes %s twice, although the last one alone is valid',
    async (_name, written, problem) => {
      const source = written()
      // What makes it worth a check of its own: the parsed value is a valid list.
      expect(() => ClientJourneysSchema.parse(JSON.parse(source))).not.toThrow()
      expect(duplicateJsonKeys(source)).toEqual([problem])
      const path = await file(source)
      expect(loadClientJourneys(path)).rejects.toThrow(`${path}: ${problem}`)
    }
  )

  test('text inside a value that looks like a key is no key, and equal keys of different objects are no duplicate', async () => {
    const reason =
      'said with "sign-in": { and \\"core\\": { "decision": and a backslash \\\\", "core": never a client.'
    const list = fixture((draft) => {
      draft.scenarios['admin only'] = { core: { decision: 'not_applicable', reason } }
    })
    const source = JSON.stringify(list, null, 2)
    expect(source).toContain('\\"sign-in\\": {')
    expect(duplicateJsonKeys(source)).toEqual([])
    expect(duplicateJsonKeys('[{"a":1},{"a":[{"a":"\\"a\\":"}]}]')).toEqual([])
    expect(duplicateJsonKeys('{"a":{"b":1,"b":2},"a":[{"c":1,"c":1}]}')).toEqual([
      'duplicate key "b" in a',
      'duplicate key "a" at the top level',
      'duplicate key "c" in a',
    ])
    const loaded = await loadClientJourneys(await file(source))
    expect(scenarioDecision(loaded, 'admin only', 'core')).toEqual({
      decision: 'not_applicable',
      reason,
    })
  })

  test('the committed file writes no key twice', async () => {
    expect(duplicateJsonKeys(await Bun.file(CLIENT_JOURNEYS_FILE).text())).toEqual([])
  })

  test.each([
    ['sixty spaces', ' '.repeat(60)],
    ['a space in front', ` ${REASON}`],
    ['a line break behind', `${REASON}\n`],
    ['a few words padded out to the length', `server only${' '.repeat(40)}`],
  ])('refuses a not_applicable reason that is %s', (_name, reason) => {
    const decision = { decision: 'not_applicable', reason }
    expect(ClientDecisionSchema.safeParse(decision).success).toBe(false)
    expect(ClientDecisionSchema.safeParse({ ...decision, reason: REASON }).success).toBe(true)
  })

  test('the generated JSON Schema refuses a reason of spaces too: a reader in another language is held to the same rule', async () => {
    const schema = (await Bun.file(
      join(import.meta.dir, '../../../conformance/client-journeys.schema.json')
    ).json()) as { $defs: { ClientDecision: { anyOf?: unknown[]; oneOf?: unknown[] } } }
    const variants = (schema.$defs.ClientDecision.anyOf ?? schema.$defs.ClientDecision.oneOf) as {
      properties: { reason?: { pattern?: string; minLength?: number } }
    }[]
    const reason = variants.find((variant) => variant.properties.reason)?.properties.reason
    expect(reason?.minLength).toBe(MIN_NOT_APPLICABLE_REASON_LENGTH)
    const pattern = new RegExp(reason?.pattern ?? 'no pattern in the schema^')
    expect(pattern.test(' '.repeat(60))).toBe(false)
    expect(pattern.test(`${REASON} `)).toBe(false)
    expect(pattern.test(REASON)).toBe(true)
    expect(pattern.test(`two lines\n${REASON}`)).toBe(true)
  })

  test.each([
    ['invalid JSON', '{ not json'],
    ['a client kind nobody defined', { scenarios: { 'sign-in': { flutter: JOURNEY } } }],
    ['a decision nobody defined', { scenarios: { 'sign-in': { core: { decision: 'later' } } } }],
    [
      'not_applicable without a reason',
      { scenarios: { 'sign-in': { core: { decision: 'not_applicable' } } } },
    ],
    [
      'not_applicable with a reason of a few words',
      { scenarios: { 'sign-in': { core: { decision: 'not_applicable', reason: 'server only' } } } },
    ],
    [
      'a journey with a reason',
      { scenarios: { 'sign-in': { core: { ...NOT_APPLICABLE, decision: 'journey' } } } },
    ],
    [
      'a suite status nobody defined',
      { clients: { ...fixture().clients, core: { description: 'x', suite: 'soon' } } },
    ],
    ['a client left out of clients', { clients: { core: fixture().clients.core } }],
    [
      'a behaviour left out',
      { behaviours: { concurrent_refresh: fixture().behaviours.concurrent_refresh } },
    ],
    [
      'a behaviour nobody defined',
      {
        behaviours: { ...fixture().behaviours, telepathy: fixture().behaviours.concurrent_refresh },
      },
    ],
    ['a key nobody defined', { notes: 'x' }],
  ] as [string, string | object][])('refuses %s, naming the file', async (_name, change) => {
    const text = typeof change === 'string' ? change : JSON.stringify({ ...fixture(), ...change })
    const path = await file(text)
    expect(loadClientJourneys(path)).rejects.toThrow(path)
  })

  test('a scenario or a client the list leaves out is undecided', () => {
    const list = fixture()
    expect(scenarioDecision(list, 'sign-in', 'core')).toEqual(JOURNEY)
    expect(scenarioDecision(list, 'sign-in', 'swift')).toEqual(UNDECIDED)
    expect(scenarioDecision(list, 'nobody wrote this', 'core')).toEqual(UNDECIDED)
    // A scenario's name is a key of a plain object: one that an object has anyway is no entry.
    expect(scenarioDecision(list, 'constructor', 'core')).toEqual(UNDECIDED)
    expect(behaviourDecision(list, 'concurrent_refresh', 'core')).toEqual(JOURNEY)
    expect(behaviourDecision(list, 'concurrent_refresh', 'kotlin')).toEqual(UNDECIDED)
  })
})

describe('clientJourneyListProblems', () => {
  test('a list that decides everything for the clients that exist has no problem', () => {
    expect(clientJourneyListProblems(fixture(), SCENARIOS)).toEqual([])
    expect(clientJourneyListProblems(fixture(), SCENARIOS, 'core')).toEqual([])
  })

  test('a scenario with no entry is a problem for a client whose suite exists', () => {
    expect(clientJourneyListProblems(fixture(), [...SCENARIOS, 'brand new'], 'core')).toEqual([
      expect.stringContaining('conformance scenario "brand new" has no decision for core'),
    ])
  })

  test.each([
    ['said in so many words', { core: UNDECIDED }],
    ['left out of the entry', {}],
  ])('undecided, %s, is a problem under a suite that exists', (_name, entry) => {
    const list = fixture((draft) => {
      draft.scenarios['sign-in'] = entry
    })
    expect(clientJourneyListProblems(list, SCENARIOS, 'core')).toEqual([
      expect.stringContaining('"sign-in" has no decision for core'),
    ])
  })

  test('an undecided behaviour is a problem under a suite that exists', () => {
    const list = fixture((draft) => {
      draft.behaviours.refresh_without_answer.clients = {}
    })
    expect(clientJourneyListProblems(list, SCENARIOS, 'core')).toEqual([
      expect.stringContaining('client behaviour "refresh_without_answer" has no decision for core'),
    ])
  })

  test.each(['expo', 'swift', 'kotlin'] as ClientKind[])(
    'everything undecided for %s passes while its suite is planned, and fails once it exists',
    (client) => {
      const planned = fixture()
      expect(clientJourneyListProblems(planned, SCENARIOS, client)).toEqual([])
      expect(clientJourneyListProblems(planned, SCENARIOS)).toEqual([])

      const exists = fixture((draft) => {
        draft.clients[client].suite = 'exists'
      })
      const problems = clientJourneyListProblems(exists, SCENARIOS, client)
      expect(problems).toHaveLength(SCENARIOS.length + CLIENT_BEHAVIOURS.length)
      expect(problems.every((problem) => problem.includes(`has no decision for ${client}`))).toBe(
        true
      )
      // Reported when nobody is named, and not another client's failure.
      expect(clientJourneyListProblems(exists, SCENARIOS)).toEqual(problems)
      expect(clientJourneyListProblems(exists, SCENARIOS, 'core')).toEqual([])
    }
  )

  test('a planned client may decide ahead of its suite', () => {
    const list = fixture((draft) => {
      draft.scenarios['sign-in'] = { core: JOURNEY, swift: JOURNEY }
    })
    expect(clientJourneyListProblems(list, SCENARIOS)).toEqual([])
  })

  test('an entry that names no scenario is a problem, whichever client asks', () => {
    for (const client of [undefined, ...CLIENT_KINDS]) {
      expect(clientJourneyListProblems(fixture(), ['sign-in'], client)).toEqual([
        '"admin only" is in the list and is not the name of a conformance scenario',
      ])
    }
  })

  test('entries out of order of name are a problem: an entry has one place', () => {
    const { scenarios, ...rest } = fixture()
    const reversed = { ...rest, scenarios: Object.fromEntries(Object.entries(scenarios).reverse()) }
    expect(clientJourneyListProblems(reversed, SCENARIOS, 'swift')).toEqual([
      expect.stringContaining('"admin only" is out of place'),
    ])
    // By code unit, so that every language sorts alike: upper case before lower case.
    const mixed = fixture((draft) => {
      draft.scenarios = { 'OAuth sign-in': { core: JOURNEY }, ...draft.scenarios }
    })
    expect(clientJourneyListProblems(mixed, [...SCENARIOS, 'OAuth sign-in'])).toEqual([])
  })
})

describe('clientSuiteProblems', () => {
  test('a suite that has a test for every journey and nothing else agrees with the list', () => {
    expect(clientSuiteProblems(fixture(), 'core', suite())).toEqual([])
  })

  test('a journey in the list with no test in the suite', () => {
    expect(clientSuiteProblems(fixture(), 'core', suite({}))).toEqual([
      'scenario "sign-in" is a journey for core, and its suite has no test of it',
    ])
  })

  test('a test for a scenario the list says is not applicable: one or the other, never both', () => {
    const problems = clientSuiteProblems(
      fixture(),
      'core',
      suite({ 'sign-in': ['signs in'], 'admin only': ['an admin does it'] })
    )
    expect(problems).toEqual([
      expect.stringContaining('scenario "admin only" has a test in the suite of core'),
    ])
    expect(problems[0]).toContain('not_applicable')
  })

  test('a test for a scenario the list has no decision for, or does not have', () => {
    const undecided = fixture((draft) => {
      draft.scenarios['sign-in'] = {}
    })
    expect(clientSuiteProblems(undecided, 'core', suite())).toEqual([
      expect.stringContaining('scenario "sign-in" has a test in the suite of core'),
    ])
    expect(
      clientSuiteProblems(fixture(), 'core', suite({ 'sign-in': ['a'], 'renamed since': ['b'] }))
    ).toEqual([expect.stringContaining('scenario "renamed since" has a test in the suite of core')])
  })

  test('a behaviour that is a journey with no test, and a test of one that is not', () => {
    const untested = { ...suite(), behaviours: ['concurrent_refresh', 'refresh_without_answer'] }
    expect(clientSuiteProblems(fixture(), 'core', untested)).toEqual([
      'behaviour "unknown_step_not_supported" is a journey for core, and its suite has no test of it',
      'behaviour "session_kept_through_failed_refresh_offline" is a journey for core, and its suite has no test of it',
    ])
    const notApplicable = fixture((draft) => {
      draft.behaviours.concurrent_refresh.clients = { core: NOT_APPLICABLE }
    })
    expect(clientSuiteProblems(notApplicable, 'core', suite())).toEqual([
      expect.stringContaining('behaviour "concurrent_refresh" has a test in the suite of core'),
    ])
  })

  test('a behaviour the suite tests and the list does not have', () => {
    const extra = { ...suite(), behaviours: [...CLIENT_BEHAVIOURS, 'telepathy'] }
    expect(clientSuiteProblems(fixture(), 'core', extra)).toEqual([
      'the suite of core tests a behaviour "telepathy" the list does not have',
    ])
  })

  test('a reason may quote a scenario the suite covers or a test’s title, and nothing else', () => {
    const pointing = (quoted: string) =>
      fixture((draft) => {
        draft.scenarios['admin only'] = {
          core: { decision: 'not_applicable', reason: `${REASON} See "${quoted}".` },
        }
      })
    expect(clientSuiteProblems(pointing('sign-in'), 'core', suite())).toEqual([])
    expect(clientSuiteProblems(pointing('signs in'), 'core', suite())).toEqual([])
    expect(clientSuiteProblems(pointing('a test long gone'), 'core', suite())).toEqual([
      expect.stringContaining('names a journey "a test long gone" its suite does not have'),
    ])
  })

  test('a suite of a client the list still calls planned is told to say it exists', () => {
    const list = fixture((draft) => {
      draft.scenarios['sign-in'] = { core: JOURNEY, swift: JOURNEY }
      draft.scenarios['admin only'] = { core: NOT_APPLICABLE, swift: NOT_APPLICABLE }
      for (const behaviour of CLIENT_BEHAVIOURS) {
        draft.behaviours[behaviour].clients = { core: JOURNEY, swift: JOURNEY }
      }
    })
    expect(clientSuiteProblems(list, 'swift', suite())).toEqual([
      'swift has a test suite that reads the list: set clients.swift.suite to "exists"',
    ])
  })
})

describe('testsThatMayNotRun', () => {
  // A journey is registered where it is declared, so one that is declared and never run
  // would count as covered. The markers are spelled apart here so that this file passes too.
  const marked = (marker: string, call = '(') => `.${marker}${call}`

  test.each([
    ['skip', `describe${marked('skip')}'sessions', () => {`],
    ['skip', `test${marked('skip', '.each(')}[1, 2])('n %d', () => {})`],
    ['todo', `  test${marked('todo')}'later')`],
    ['only', `test${marked('only')}'this one', () => {})`],
    ['if', `test${marked('if')}process.platform === 'linux')('x', () => {})`],
    ['skipIf', `describe${marked('skipIf')}true)('x', () => {})`],
    ['todoIf', `test${marked('todoIf')}true)('x', () => {})`],
    ['failing', `test${marked('failing')}'x', () => {})`],
    ['skip', `test\n    ${marked('skip', ' (')}'broken over two lines', () => {})`],
    // Every one of these skips under `bun test`: white space round the dot, the break
    // after it, a member named in brackets, and a member read now and called later.
    ['skip', `test . ${'skip'} ('spaces round the dot', () => {})`],
    ['skip', `test.\n  ${'skip'}('the break after the dot', () => {})`],
    ['only', `test // why\n  .\n  ${'only'}('a comment before the dot', () => {})`],
    ['skip', `test['${'skip'}']('single quotes', () => {})`],
    ['only', `test["${'only'}"]('double quotes', () => {})`],
    ['todo', `test[\`${'todo'}\`]('a template', () => {})`],
    ['skipIf', `describe[ '${'skipIf'}' ](true)('spaces in the brackets', () => {})`],
    ['if', `test['${'if'}'](false)('x', () => {})`],
    ['todoIf', `test["${'todoIf'}"](true)('x', () => {})`],
    ['failing', `test['${'failing'}']('x', () => {})`],
    ['skip', `const later = test.${'skip'}\nlater('an alias', () => {})`],
    ['only', `const later = [describe.${'only'}]`],
    ['if', `const when = test.${'if'};`],
  ])('finds .%s', (marker, line) => {
    const source = `import { test } from 'bun:test'\n\n${line}\n`
    expect(testsThatMayNotRun(source)).toEqual([
      expect.stringMatching(new RegExp(`^line [345]: \\.${marker} `)),
    ])
  })

  test.each([
    ['xit', `${'x'}it('x', () => {})`],
    ['xtest', `  ${'x'}test ('x', () => {})`],
    ['xdescribe', `${'x'}describe('x', () => {})`],
    ['xit', `import { ${'x'}it as later } from 'bun:test'`],
  ])('finds %s, which bun:test exports as a test that does not run', (word, line) => {
    expect(testsThatMayNotRun(`\n${line}\n`)).toEqual([
      `line 2: ${word} declares a test that may not run, and a journey is counted where it is declared`,
    ])
  })

  test.each([
    ['a process that ends', 'process.exit(1)'],
    ['an iterator', 'const { value } = entries.next()'],
    ['a word that ends like one', 'textit(caption)\nmaxit(3)\ncontextest(1)\nxitem(2)'],
    ['a condition', 'if (ready) {\n  go()\n}'],
    ['a condition after a call', 'start()\nif (ready) { go() }'],
    [
      'a member that begins like one',
      'page.iframe()\nlist.onlyChild\nrow.skipped\nx.todos\ny.ifNot',
    ],
    ['a key in brackets that is none', "row['skipped']\nrow[skip]\nrow['if only']"],
    [
      'a sentence that ends a comment, before a condition',
      '      // The first code was retired by the resend.\n      if (second) {',
    ],
    ['a sentence at the end of a line of code', 'go() // and that is all there is.\nif (x) {}'],
    [
      'a sentence that ends a block comment’s line',
      '/**\n * Skipped on purpose.\n * only here.\n */',
    ],
    ['a block comment that ends in a full stop', '/* nothing more. */\nif (x) {}'],
  ])('leaves %s alone', (_name, source) => {
    expect(testsThatMayNotRun(source)).toEqual([])
  })

  test('a comment in front of a dot does not hide what follows the dot', () => {
    expect(testsThatMayNotRun(`/* why */ test.\n  ${'skip'}('x', () => {})`)).toHaveLength(1)
    expect(testsThatMayNotRun(`go('//') ; test.${'skip'}('x', () => {})`)).toHaveLength(1)
  })

  test('what the scan does not see, said so that nobody takes it for more: a comment between the dot and the name, and a member taken out by destructuring', () => {
    // Both skip under `bun test`. The JSDoc and the README name them; closing them needs a
    // parser, not a scan.
    expect(testsThatMayNotRun(`test. // why\n  ${'skip'}('x', () => {})`)).toEqual([])
    expect(testsThatMayNotRun(`const { ${'skip'} } = test\n${'skip'}('x', () => {})`)).toEqual([])
  })

  test('the work is bounded: a long run of white space after a dot, many times over', () => {
    const source = `x.${' '.repeat(2000)}y\n`.repeat(2000)
    const started = performance.now()
    expect(testsThatMayNotRun(source)).toEqual([])
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test('says every line, and leaves a suite that runs everything alone', () => {
    const source = [
      "journey('sign-in', 'signs in', async () => {",
      '  const skipped = list.onlyChild',
      "  expect(flow.step.status).toBe('complete')",
      '  if (ready) { await tula.session.signOut() }',
      '})',
      `journey${marked('skip')}'x', 'y', run)`,
      "test.each([1])('n %d', () => {})",
      `describe${marked('only')}'z', () => {})`,
    ].join('\n')
    expect(testsThatMayNotRun(source)).toEqual([
      'line 6: .skip declares a test that may not run, and a journey is counted where it is declared',
      'line 8: .only declares a test that may not run, and a journey is counted where it is declared',
    ])
  })
})
