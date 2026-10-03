import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type Scenario, ScenarioSchema } from './scenario'

/** The scenario files shipped with the repository. */
export const SCENARIOS_DIR = join(import.meta.dir, '../../../conformance/scenarios')

/**
 * Load and validate every scenario in a directory.
 *
 * @param directory - Where the `*.json` scenarios are (default: `/conformance/scenarios`).
 * @returns The scenarios, in file-name order, each with the file it came from.
 * @throws Error naming the file when one is not valid JSON or not a valid scenario.
 */
export async function loadScenarios(
  directory: string = SCENARIOS_DIR
): Promise<{ file: string; scenario: Scenario }[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort()
  return Promise.all(
    files.map(async (file) => {
      try {
        const scenario = ScenarioSchema.parse(await Bun.file(join(directory, file)).json())
        return { file, scenario }
      } catch (error) {
        throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  )
}
