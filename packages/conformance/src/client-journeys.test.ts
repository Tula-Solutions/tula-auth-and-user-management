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
  type ClientJourneys,
  ClientJourneysSchema,
  type ClientKind,
  clientJourneyListProblems,
  clientSuiteProblems,
  loadClientJourneys,
  scenarioDecision,
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
