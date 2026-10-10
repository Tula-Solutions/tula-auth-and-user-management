import { join } from 'node:path'
import { z } from 'zod'

/** The list every client's test suite reads: `/conformance/client-journeys.json`. */
export const CLIENT_JOURNEYS_FILE = join(
  import.meta.dir,
  '../../../conformance/client-journeys.json'
)

/**
 * The clients whose test suites are held to the list, a closed set: `core` is `@tula/core`
 * (TypeScript), the other three are the Expo, Swift and Kotlin SDKs.
 */
export const CLIENT_KINDS = ['core', 'expo', 'swift', 'kotlin'] as const

/** One of {@link CLIENT_KINDS}. */
export type ClientKind = (typeof CLIENT_KINDS)[number]

/**
 * The named client behaviours, a closed set. They are what a client does on its own, between
 * requests, and so what no HTTP scenario can show: each client proves them in its own suite.
 * A new one is added here, described in the list and decided for every client whose suite
 * exists.
 */
export const CLIENT_BEHAVIOURS = [
  'concurrent_refresh',
  'refresh_without_answer',
  'unknown_step_not_supported',
  'session_kept_through_failed_refresh_offline',
] as const

/** One of {@link CLIENT_BEHAVIOURS}. */
export type ClientBehaviour = (typeof CLIENT_BEHAVIOURS)[number]

/**
 * The shortest reason a `not_applicable` decision may give. A reason has to say why no client
 * of that kind can reach the scenario, which a few words cannot.
 */
export const MIN_NOT_APPLICABLE_REASON_LENGTH = 41

/**
 * A reason begins and ends with something a reader sees: no white space in front or behind,
 * so that its length is the length of what it says and padding cannot stand in for words.
 * A pattern, and not a trim, because a pattern is what the JSON Schema can say too.
 */
const REASON_WITHOUT_PADDING = /^\S[\s\S]*\S$/

/**
 * What one client does about one scenario or behaviour.
 *
 * - `journey`: the client's suite has a test of that name.
 * - `not_applicable`: nothing a client of that kind does can reach it; `reason` says why. It
 *   may name, in double quotes, the scenario whose journey covers the client's side.
 * - `undecided`: nobody has decided yet. Leaving the client out says the same. Allowed only
 *   while the client's suite is `planned`.
 */
export const ClientDecisionSchema = z
  .discriminatedUnion('decision', [
    z.strictObject({ decision: z.literal('journey') }),
    z.strictObject({
      decision: z.literal('not_applicable'),
      reason: z.string().min(MIN_NOT_APPLICABLE_REASON_LENGTH).regex(REASON_WITHOUT_PADDING),
    }),
    z.strictObject({ decision: z.literal('undecided') }),
  ])
  .meta({ id: 'ClientDecision' })

/** A decision of {@link ClientDecisionSchema}. */
export type ClientDecision = z.infer<typeof ClientDecisionSchema>

const perClient = <Value extends z.ZodType>(value: Value) =>
  z.strictObject(
    Object.fromEntries(CLIENT_KINDS.map((client) => [client, value])) as Record<ClientKind, Value>
  )

/** The decisions of one scenario or behaviour, by client. A client left out is undecided. */
export const ClientDecisionsSchema = perClient(ClientDecisionSchema.optional()).meta({
  id: 'ClientDecisions',
})

/**
 * Whether a client has a test suite that reads the list. `planned`: none yet, and whatever
 * is undecided for it fails nothing. `exists`: its suite's guard fails for every scenario
 * and behaviour that is undecided for it.
 */
export const ClientSuiteSchema = z.enum(['exists', 'planned']).meta({ id: 'ClientSuite' })

/**
 * The client-journey list: for every conformance scenario and every named client behaviour,
 * what each client's test suite does about it. Plain JSON, so that the TypeScript, Swift and
 * Kotlin suites read one file.
 */
export const ClientJourneysSchema = z
  .strictObject({
    /** JSON Schema reference, for editors. */
    $schema: z.string().optional(),
    /** Every client kind, with what it is and whether its suite exists. */
    clients: perClient(
      z.strictObject({ description: z.string().min(1), suite: ClientSuiteSchema })
    ),
    /** Scenario name → decisions. In order of name, by UTF-16 code unit. */
    scenarios: z.record(z.string().min(1), ClientDecisionsSchema),
    /** Behaviour id → what it is and the decisions. */
    behaviours: z.strictObject(
      Object.fromEntries(
        CLIENT_BEHAVIOURS.map((behaviour) => [
          behaviour,
          z.strictObject({ description: z.string().min(1), clients: ClientDecisionsSchema }),
        ])
      ) as Record<
        ClientBehaviour,
        z.ZodObject<{ description: z.ZodString; clients: typeof ClientDecisionsSchema }>
      >
    ),
  })
  .meta({ title: 'ClientJourneys' })

/** A list of {@link ClientJourneysSchema}. */
export type ClientJourneys = z.infer<typeof ClientJourneysSchema>

/**
 * The keys a JSON text writes twice in one object, at any depth.
 *
 * JSON does not say which of two equal keys counts: `JSON.parse` keeps the last and reports
 * nothing, and a parser in another language may keep the first. A decision written twice
 * could so be two decisions, one per reader. Only the text shows it, so this reads the
 * text: one pass, a string skipped as a whole (escapes included), a key being a string
 * that a colon follows. Keys are compared as the strings they spell, so an escaped
 * spelling of a key is that key.
 *
 * @param text - A JSON text that `JSON.parse` accepts; anything else has no defined answer.
 * @returns One sentence per repeated key, in the order they are written; empty when every
 *   key of every object is written once.
 * @example
 * duplicateJsonKeys('{"scenarios":{"sign-up":{},"sign-up":{}}}')
 * // ['duplicate key "sign-up" in scenarios']
 */
export function duplicateJsonKeys(text: string): string[] {
  const problems: string[] = []
  // One frame per object or array that is open: the keys an object has had so far (an array
  // has none), and the key whose value is being read, which names the place in a problem.
  const open: { keys: Set<string> | null; at: string | null }[] = []
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === '{') {
      open.push({ keys: new Set(), at: null })
    } else if (character === '[') {
      open.push({ keys: null, at: null })
    } else if (character === '}' || character === ']') {
      open.pop()
    } else if (character === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1
      }
      let after = end + 1
      while (' \t\n\r'.includes(text[after] ?? 'x')) {
        after += 1
      }
      const frame = open.at(-1)
      if (frame?.keys && text[after] === ':') {
        const key = JSON.parse(text.slice(index, end + 1)) as string
        if (frame.keys.has(key)) {
          const place = open.slice(0, -1).flatMap((outer) => (outer.at === null ? [] : [outer.at]))
          problems.push(
            `duplicate key ${JSON.stringify(key)} ${place.length > 0 ? `in ${place.join('.')}` : 'at the top level'}`
          )
        }
        frame.keys.add(key)
        frame.at = key
      }
      index = end
    }
    index += 1
  }
  return problems
}

/** What marks a test of `bun:test` as one that may not run, or that keeps the others from it. */
const UNRUN_TEST_MARKERS = /\.(skip|todo|only|if|skipIf|todoIf|failing)\s*[.(]/g

/**
 * The places where a test file declares a test that may not run.
 *
 * A suite registers a journey where it is declared, so a journey inside `describe.skip`
 * would count as covered and prove nothing. A suite's guard gives this its own source and
 * expects nothing back. It reads text, not syntax, and errs towards refusing: the same
 * spelling in a comment, a string or a method of that name is found too, and is reworded.
 * It does not show that a declared test asserted anything: that is the test's own business.
 *
 * @param source - The text of the suite's test file.
 * @returns One sentence per place, with its line; empty when there is none.
 * @example
 * expect(testsThatMayNotRun(await Bun.file(import.meta.path).text())).toEqual([])
 */
export function testsThatMayNotRun(source: string): string[] {
  return [...source.matchAll(UNRUN_TEST_MARKERS)].map((match) => {
    const line = source.slice(0, match.index).split('\n').length
    return `line ${line}: .${match[1]} declares a test that may not run, and a journey is counted where it is declared`
  })
}

/**
 * Load and validate the client-journey list.
 *
 * Every TypeScript reader of the list goes through here, so that a file which writes a key
 * twice ({@link duplicateJsonKeys}) is refused for all of them.
 *
 * @param path - The file (default: `/conformance/client-journeys.json`).
 * @returns The list.
 * @throws Error naming the file when it is not valid JSON, writes a key twice or is not a
 *   valid list.
 */
export async function loadClientJourneys(
  path: string = CLIENT_JOURNEYS_FILE
): Promise<ClientJourneys> {
  try {
    const text = await Bun.file(path).text()
    const value: unknown = JSON.parse(text)
    const twice = duplicateJsonKeys(text)
    if (twice.length > 0) {
      throw new Error(twice.join('; '))
    }
    return ClientJourneysSchema.parse(value)
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * What a client does about a scenario, as the list has it.
 *
 * @param list - The client-journey list.
 * @param scenario - The scenario's name.
 * @param client - The client kind.
 * @returns The decision; `undecided` for a scenario or a client the list leaves out.
 */
export function scenarioDecision(
  list: ClientJourneys,
  scenario: string,
  client: ClientKind
): ClientDecision {
  const entry = Object.hasOwn(list.scenarios, scenario) ? list.scenarios[scenario] : undefined
  return entry?.[client] ?? { decision: 'undecided' }
}

/**
 * What a client does about a named behaviour, as the list has it.
 *
 * @param list - The client-journey list.
 * @param behaviour - The behaviour's id.
 * @param client - The client kind.
 * @returns The decision; `undecided` for a client the list leaves out.
 */
export function behaviourDecision(
  list: ClientJourneys,
  behaviour: ClientBehaviour,
  client: ClientKind
): ClientDecision {
  return list.behaviours[behaviour].clients[client] ?? { decision: 'undecided' }
}

/**
 * What is wrong with the list itself, whoever reads it.
 *
 * Three rules a JSON Schema cannot express: every entry names a scenario that exists, the
 * entries are in order of name (so an entry has one place, and two branches that each add a
 * scenario seldom touch the same lines), and a client whose suite exists has decided
 * everything. A scenario with no entry at all is undecided for every client.
 *
 * @param list - The client-journey list.
 * @param scenarios - The name of every conformance scenario.
 * @param client - Report what is undecided for this client only; every client when left out.
 *   A suite passes its own kind, so that another client's missing decision is not its failure.
 * @returns One sentence per problem; empty when there is none.
 * @example
 * const names = (await loadScenarios()).map(({ scenario }) => scenario.name)
 * expect(clientJourneyListProblems(await loadClientJourneys(), names, 'core')).toEqual([])
 */
export function clientJourneyListProblems(
  list: ClientJourneys,
  scenarios: readonly string[],
  client?: ClientKind
): string[] {
  const problems: string[] = []
  const existing = new Set(scenarios)
  const listed = Object.keys(list.scenarios)
  for (const name of listed) {
    if (!existing.has(name)) {
      problems.push(`"${name}" is in the list and is not the name of a conformance scenario`)
    }
  }
  const outOfOrder = listed.find((name, index) => index > 0 && name < (listed[index - 1] as string))
  if (outOfOrder !== undefined) {
    problems.push(
      `"${outOfOrder}" is out of place: the scenarios are listed in order of name (by code unit)`
    )
  }
  for (const kind of client ? [client] : CLIENT_KINDS) {
    if (list.clients[kind].suite !== 'exists') {
      continue
    }
    for (const name of scenarios) {
      if (scenarioDecision(list, name, kind).decision === 'undecided') {
        problems.push(
          `conformance scenario "${name}" has no decision for ${kind}: ` +
            'give it "journey" or "not_applicable" with a reason in conformance/client-journeys.json'
        )
      }
    }
    for (const behaviour of CLIENT_BEHAVIOURS) {
      if (behaviourDecision(list, behaviour, kind).decision === 'undecided') {
        problems.push(
          `client behaviour "${behaviour}" has no decision for ${kind}: ` +
            'give it "journey" or "not_applicable" with a reason in conformance/client-journeys.json'
        )
      }
    }
  }
  return problems
}

/** What a client's test suite has, as that suite collected it while registering its tests. */
export interface ClientSuite {
  /** Scenario name → the titles of the tests that cover it. */
  journeys: ReadonlyMap<string, readonly string[]>
  /** The behaviours the suite has a test of. */
  behaviours: Iterable<string>
}

/**
 * Where a client's test suite and the list disagree.
 *
 * In both directions: a `journey` the suite has no test for, and a test for something the
 * list says is not applicable, is undecided or does not have at all. A `not_applicable`
 * reason that names a journey in double quotes (a scenario the client covers, or a test's
 * own title) must name one the suite has: a reader would otherwise be sent to a test that is
 * not there. A client whose suite calls this is no longer `planned`, and is told so.
 *
 * It is given what the suite's tests registered, which is that a test is **declared**, not
 * that it ran: a suite also has to show that none of its tests is skipped
 * ({@link testsThatMayNotRun} for a `bun:test` file).
 *
 * @param list - The client-journey list.
 * @param client - The client the suite belongs to.
 * @param suite - The journeys and behaviours the suite's tests registered.
 * @returns One sentence per problem; empty when the two agree.
 * @example
 * expect(clientSuiteProblems(list, 'core', { journeys: covered, behaviours: proven })).toEqual([])
 */
export function clientSuiteProblems(
  list: ClientJourneys,
  client: ClientKind,
  suite: ClientSuite
): string[] {
  const problems: string[] = []
  if (list.clients[client].suite !== 'exists') {
    problems.push(
      `${client} has a test suite that reads the list: set clients.${client}.suite to "exists"`
    )
  }
  const behaviours = new Set(suite.behaviours)
  const titles = new Set([...suite.journeys.values()].flat())
  const reasons: [string, string][] = []

  const compare = (what: string, name: string, decision: ClientDecision, tested: boolean) => {
    if (decision.decision === 'journey' && !tested) {
      problems.push(`${what} "${name}" is a journey for ${client}, and its suite has no test of it`)
    }
    if (decision.decision !== 'journey' && tested) {
      problems.push(
        `${what} "${name}" has a test in the suite of ${client}, and the list says ` +
          `${decision.decision}, not journey: one or the other, never both`
      )
    }
    if (decision.decision === 'not_applicable') {
      reasons.push([name, decision.reason])
    }
  }
  for (const name of new Set([...Object.keys(list.scenarios), ...suite.journeys.keys()])) {
    compare('scenario', name, scenarioDecision(list, name, client), suite.journeys.has(name))
  }
  for (const behaviour of CLIENT_BEHAVIOURS) {
    compare(
      'behaviour',
      behaviour,
      behaviourDecision(list, behaviour, client),
      behaviours.delete(behaviour)
    )
  }
  for (const unknown of behaviours) {
    problems.push(`the suite of ${client} tests a behaviour "${unknown}" the list does not have`)
  }
  for (const [name, reason] of reasons) {
    for (const [, quoted] of reason.matchAll(/"([^"]+)"/g)) {
      if (!suite.journeys.has(quoted as string) && !titles.has(quoted as string)) {
        problems.push(
          `the reason "${name}" is not applicable to ${client} names a journey "${quoted}" ` +
            'its suite does not have'
        )
      }
    }
  }
  return problems
}
