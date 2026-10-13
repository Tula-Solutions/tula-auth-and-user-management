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
 * The ticket a `not_built` decision names: the one whose work turns it into a `journey`.
 * An issue id of the project's tracker, so that "later" is a thing somebody can look up.
 */
export const NOT_BUILT_TICKET_PATTERN = /^TULA-[0-9]+$/

const reason = z.string().min(MIN_NOT_APPLICABLE_REASON_LENGTH).regex(REASON_WITHOUT_PADDING)
const journey = z.strictObject({ decision: z.literal('journey') })
const notApplicable = z.strictObject({ decision: z.literal('not_applicable'), reason })
const undecided = z.strictObject({ decision: z.literal('undecided') })

/**
 * What one client does about one scenario.
 *
 * - `journey`: the client's suite has a test of that name.
 * - `not_applicable`: nothing a client of that kind does can reach it, in this version or
 *   any other; `reason` says why. It may name, in double quotes, the scenario whose journey
 *   covers the client's side.
 * - `not_built`: a client of that kind does reach it, and this client has no call for it
 *   yet. `ticket` is the issue that builds it and `reason` says what is missing, under the
 *   rules of a `not_applicable` reason. It is a debt with a name: counted
 *   ({@link notBuilt}), allowed only for a client whose suite exists, and never for a
 *   behaviour.
 * - `undecided`: nobody has decided yet. Leaving the client out says the same. Allowed only
 *   while the client's suite is `planned`.
 */
export const ClientDecisionSchema = z
  .discriminatedUnion('decision', [
    journey,
    notApplicable,
    z.strictObject({
      decision: z.literal('not_built'),
      ticket: z.string().regex(NOT_BUILT_TICKET_PATTERN),
      reason,
    }),
    undecided,
  ])
  .meta({ id: 'ClientDecision' })

/** A decision of {@link ClientDecisionSchema}. */
export type ClientDecision = z.infer<typeof ClientDecisionSchema>

/**
 * What one client does about one named behaviour: a scenario's decisions without
 * `not_built`. A behaviour is what a client does on its own between requests (it refreshes
 * once, it keeps a session through a failure): a client that exists either does it or has a
 * fault, and there is no feature whose absence excuses it.
 */
export const ClientBehaviourDecisionSchema = z
  .discriminatedUnion('decision', [journey, notApplicable, undecided])
  .meta({ id: 'ClientBehaviourDecision' })

/** A decision of {@link ClientBehaviourDecisionSchema}. */
export type ClientBehaviourDecision = z.infer<typeof ClientBehaviourDecisionSchema>

const perClient = <Value extends z.ZodType>(value: Value) =>
  z.strictObject(
    Object.fromEntries(CLIENT_KINDS.map((client) => [client, value])) as Record<ClientKind, Value>
  )

/** The decisions of one scenario, by client. A client left out is undecided. */
export const ClientDecisionsSchema = perClient(ClientDecisionSchema.optional()).meta({
  id: 'ClientDecisions',
})

/** The decisions of one behaviour, by client. A client left out is undecided. */
export const ClientBehaviourDecisionsSchema = perClient(
  ClientBehaviourDecisionSchema.optional()
).meta({ id: 'ClientBehaviourDecisions' })

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
          z.strictObject({
            description: z.string().min(1),
            clients: ClientBehaviourDecisionsSchema,
          }),
        ])
      ) as Record<
        ClientBehaviour,
        z.ZodObject<{ description: z.ZodString; clients: typeof ClientBehaviourDecisionsSchema }>
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

/**
 * The members of `test` and `describe` (`bun:test`) that make a test one that may not run,
 * or that keep the others from running.
 */
const UNRUN_MEMBERS = 'skip|todo|only|if|skipIf|todoIf|failing'

// Three spellings, each one pass with no quantifier inside another. A member is found
// whether or not it is called there: read now and called later is the same test.
/** `test.skip`, with any white space after the dot (before it needs no pattern). */
const UNRUN_DOTTED = new RegExp(`\\.(\\s*)(${UNRUN_MEMBERS})\\b`, 'g')
/** `test['skip']`, in any of the three kinds of quotes. */
const UNRUN_BRACKETED = new RegExp(`\\[\\s*(['"\`])(${UNRUN_MEMBERS})\\1\\s*\\]`, 'g')
/** The names `bun:test` exports for a test or a block that does not run. */
const UNRUN_NAMES = /\b(xit|xtest|xdescribe)\b/g

/**
 * Whether a line, up to a full stop that ends it, is a comment's: the full stop is then a
 * sentence's and what the next line starts with (`if (…) {`) is no member of anything.
 */
function endsInComment(line: string): boolean {
  const opened = line.lastIndexOf('/*')
  return (
    line.includes('//') ||
    line.trimStart().startsWith('*') ||
    (opened !== -1 && !line.includes('*/', opened))
  )
}

/**
 * The places where a test file declares a test that may not run.
 *
 * A suite registers a journey where it is declared, so a journey inside `describe.skip`
 * would count as covered and prove nothing. A suite's guard gives this its own source and
 * expects nothing back.
 *
 * Found: a member `skip`, `todo`, `only`, `if`, `skipIf`, `todoIf` or `failing`, as a whole
 * word after a dot (white space and line breaks round the dot included) or as a quoted name
 * in brackets, called there or not (`const later = test.skip` is found where it is read);
 * and the names `xit`, `xtest` and `xdescribe` anywhere.
 *
 * It reads text, not syntax, and errs towards refusing: the same spelling in a comment, a
 * string or a member of that name on anything else is found too, and is reworded. One
 * thing is let through on purpose: a full stop that ends a comment's line, followed by a
 * line that starts with one of the words (a sentence, then `if (…) {`).
 *
 * **Not seen**, and a scan cannot: a member taken out by destructuring
 * (`const { skip } = test`), a name put together at run time (`test[name]`), a comment
 * between the dot and the name, and a dot at the end of a line that holds `//` inside a
 * string. Nor does it show that a declared test asserted anything: that is the test's own
 * business.
 *
 * @param source - The text of the suite's test file.
 * @returns One sentence per place, in the file's order, with its line; empty when there is
 *   none.
 * @example
 * expect(testsThatMayNotRun(await Bun.file(import.meta.path).text())).toEqual([])
 */
export function testsThatMayNotRun(source: string): string[] {
  const found: { index: number; what: string }[] = []
  for (const match of source.matchAll(UNRUN_DOTTED)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1
    const sentence = match[1]?.includes('\n') && endsInComment(source.slice(lineStart, match.index))
    if (!sentence) {
      found.push({ index: match.index, what: `.${match[2]}` })
    }
  }
  for (const match of source.matchAll(UNRUN_BRACKETED)) {
    found.push({ index: match.index, what: `.${match[2]}` })
  }
  for (const match of source.matchAll(UNRUN_NAMES)) {
    found.push({ index: match.index, what: `${match[1]}` })
  }
  return found
    .sort((one, other) => one.index - other.index)
    .map(({ index, what }) => {
      const line = source.slice(0, index).split('\n').length
      return `line ${line}: ${what} declares a test that may not run, and a journey is counted where it is declared`
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
): ClientBehaviourDecision {
  return list.behaviours[behaviour].clients[client] ?? { decision: 'undecided' }
}

/**
 * What is wrong with the list itself, whoever reads it.
 *
 * Four rules a JSON Schema cannot express: every entry names a scenario that exists, the
 * entries are in order of name (so an entry has one place, and two branches that each add a
 * scenario seldom touch the same lines), a client whose suite exists has decided
 * everything, and a client whose suite is only planned has nothing `not_built` (nothing of
 * it is built: a ticket per scenario would be a guess). A scenario with no entry at all is
 * undecided for every client.
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
      for (const { scenario } of notBuilt(list, kind)) {
        problems.push(
          `scenario "${scenario}" is not_built for ${kind}, whose suite is only planned: ` +
            'not_built is for a client that exists and lacks one feature; leave it undecided'
        )
      }
      continue
    }
    for (const name of scenarios) {
      if (scenarioDecision(list, name, kind).decision === 'undecided') {
        problems.push(
          `conformance scenario "${name}" has no decision for ${kind}: give it "journey", ` +
            '"not_applicable" with a reason, or "not_built" with a ticket and a reason, ' +
            'in conformance/client-journeys.json'
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

/** A scenario a client does not cover yet, and the ticket that will. */
export interface NotBuilt {
  /** The scenario's name. */
  scenario: string
  /** The issue that builds what is missing. */
  ticket: string
}

/**
 * What a client has not built yet: every scenario the list marks `not_built` for it, in the
 * list's order. The number is the client's debt against the suite, and a test can hold it
 * (so that it only shrinks on purpose and never grows unnoticed).
 *
 * @param list - The client-journey list.
 * @param client - The client kind.
 * @returns The scenarios and their tickets; empty for a client that has built everything it
 *   can reach.
 * @example
 * expect(notBuilt(await loadClientJourneys(), 'core')).toEqual([])
 */
export function notBuilt(list: ClientJourneys, client: ClientKind): NotBuilt[] {
  const found: NotBuilt[] = []
  for (const [scenario, decisions] of Object.entries(list.scenarios)) {
    const decision = decisions[client]
    if (decision?.decision === 'not_built') {
      found.push({ scenario, ticket: decision.ticket })
    }
  }
  return found
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
 * list says is not applicable, is not built, is undecided or does not have at all. A
 * `not_built` scenario with a test behind it is built: its entry is out of date. A reason
 * (of `not_applicable` or `not_built`) that names a journey in double quotes (a scenario
 * the client covers, or a test's own title) must name one the suite has: a reader would
 * otherwise be sent to a test that is not there. A client whose suite calls this is no longer `planned`, and is told so.
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
    if (decision.decision === 'not_applicable' || decision.decision === 'not_built') {
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
          `the reason "${name}" is not a journey of ${client} names a journey "${quoted}" ` +
            'its suite does not have'
        )
      }
    }
  }
  return problems
}
