import { durationToMs } from '@tula-tech/contract'
import { changesSettings, runScenario, type ScenarioResult, type Target } from './runner'
import type { Scenario } from './scenario'

/** An environment of the server under test, named by its two keys. */
export interface LaneEnvironment {
  /** A publishable key of the environment. */
  publishableKey: string
  /** A secret key of the same environment. */
  secretKey: string
}

/**
 * How long a scenario will take, as far as its own steps say: its `wait` steps, and the settle
 * after each write to the settings (`Target.settleMs`), in the scenario and in its cleanup.
 * Used only to start the longest scenarios first, so that the lanes end together.
 *
 * @param scenario - A parsed scenario.
 * @param settleMs - The target's settle time, 0 for none.
 * @returns The sum, in milliseconds. Requests and processing are not counted.
 */
export function estimateMs(scenario: Scenario, settleMs: number): number {
  let total = 0
  for (const step of [...scenario.steps, ...(scenario.cleanup ?? [])]) {
    if ('wait' in step) {
      total += durationToMs(step.wait)
    } else if ('request' in step && changesSettings(step.request)) {
      total += settleMs
    }
  }
  return total
}

/**
 * Read `CONFORMANCE_ENVIRONMENTS`: the keys of the extra environments a run may use.
 *
 * @param value - Comma-separated `publishableKey:secretKey` pairs, or nothing.
 * @returns One entry per pair, none for nothing.
 * @throws Error when a pair lacks either key.
 */
export function parseEnvironments(value: string | undefined): LaneEnvironment[] {
  if (value === undefined || value.trim() === '') {
    return []
  }
  return value.split(',').map((pair) => {
    const [publishableKey, secretKey, ...rest] = pair.trim().split(':')
    if (!publishableKey || !secretKey || rest.length > 0) {
      throw new Error(
        'CONFORMANCE_ENVIRONMENTS must be pairs of a publishable key and a secret key (publishable:secret), separated by commas'
      )
    }
    return { publishableKey, secretKey }
  })
}

/**
 * One target for each environment a run may use: the one given, then the extra ones, which
 * share its server, its test doubles and its settle time and differ in the keys.
 *
 * @param base - The target of the primary environment.
 * @param extra - The other environments.
 * @returns The targets; the first is `base` itself.
 */
export function laneTargets(base: Target, extra: readonly LaneEnvironment[]): Target[] {
  return [base, ...extra.map((environment) => ({ ...base, ...environment }))]
}

/** What {@link runScenarios} may be told. */
export interface RunScenariosOptions {
  /** Called with each result as it is known, in the order they finish. */
  onResult?: (result: ScenarioResult) => void
  /** Scenarios for which this is true run alone, after all the others. */
  serial?: (scenario: Scenario) => boolean
  /** How one scenario is run (default {@link runScenario}); tests pass their own. */
  run?: (scenario: Scenario, target: Target) => Promise<ScenarioResult>
}

/**
 * Run scenarios at the same time, one lane for each target.
 *
 * A scenario changes its environment's settings and puts them back in `cleanup`, so two of them
 * in one environment would see each other's. Every target is an environment of its own: a lane
 * runs one scenario at a time, and the lanes run side by side, so that the scenarios' waits
 * (rate-limit windows, authenticator steps, the settle) overlap instead of adding up. The
 * longest scenarios start first. A `serial` scenario runs on its own, on the first target, once
 * the others have ended.
 *
 * @param scenarios - The scenarios, in the order their results are returned.
 * @param targets - One target per environment; at least one.
 * @param options - Callbacks and the serial rule.
 * @returns A result for every scenario, in the order of `scenarios`. A scenario whose run threw
 *   is a failed result.
 * @throws Error when there is no target.
 */
export async function runScenarios(
  scenarios: readonly Scenario[],
  targets: readonly Target[],
  options: RunScenariosOptions = {}
): Promise<ScenarioResult[]> {
  const first = targets[0]
  if (!first) {
    throw new Error('runScenarios needs at least one environment to run in')
  }
  const run = options.run ?? runScenario
  const results = new Map<Scenario, ScenarioResult>()

  async function one(scenario: Scenario, target: Target): Promise<void> {
    let result: ScenarioResult
    try {
      result = await run(scenario, target)
    } catch (error) {
      result = {
        name: scenario.name,
        status: 'failed',
        steps: [
          {
            name: 'run the scenario',
            ok: false,
            problems: [error instanceof Error ? error.message : String(error)],
          },
        ],
      }
    }
    results.set(scenario, result)
    options.onResult?.(result)
  }

  const settle = first.settleMs ?? 0
  const isSerial = options.serial ?? (() => false)
  const queue = scenarios
    .filter((scenario) => !isSerial(scenario))
    .map((scenario, index) => ({ scenario, index, estimate: estimateMs(scenario, settle) }))
    // Longest first; equal ones keep their order.
    .sort((a, b) => b.estimate - a.estimate || a.index - b.index)
    .map(({ scenario }) => scenario)

  await Promise.all(
    targets.map(async (target) => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await one(next, target)
      }
    })
  )
  for (const scenario of scenarios.filter(isSerial)) {
    await one(scenario, first)
  }
  return scenarios.map((scenario) => results.get(scenario) as ScenarioResult)
}
