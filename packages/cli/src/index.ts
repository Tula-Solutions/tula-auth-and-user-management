import { applyCommand } from './commands/apply'
import { devCommand } from './commands/dev'
import { diffCommand } from './commands/diff'
import { doctorCommand } from './commands/doctor'
import { policyCommand } from './commands/policy'
import { type CliIo, type Command, runCli } from './framework'
import { processIo } from './process-io'

export { type OptionSpec, type ParsedArgs, parseArgs, UsageError } from './args'
export { applyCommand } from './commands/apply'
export { devCommand } from './commands/dev'
export { diffCommand } from './commands/diff'
export { doctorCommand } from './commands/doctor'
export { policyCommand } from './commands/policy'
export {
  DEV_ENV_FILE,
  type DevOptions,
  parseDevBlock,
  startDev,
  stopDev,
  withDevBlock,
  withoutDevBlock,
} from './dev'
export {
  buildPlan,
  type Change,
  diffValues,
  MANAGING_TOOL,
  type MarkerPlan,
  type Operation,
  orderOperations,
  type Plan,
  type PlanOptions,
  type ProviderChange,
  planProviders,
  type RemoteProvider,
  type RemoteState,
  SET_PATHS,
} from './diff'
export {
  type CheckStatus,
  type DoctorCheck,
  type DoctorReport,
  examine,
  exitCode,
  printable,
  renderReport,
  reportToJson,
} from './doctor'
export {
  type CliIo,
  type Command,
  type CommandContext,
  EXIT,
  reportError,
  runCli,
} from './framework'
export type { Host, RunOptions, RunResult } from './host'
export { createOutput, type Output, type Sink, type Styles, shouldUseColor } from './output'
export {
  applyRequirements,
  describeOperation,
  planToJson,
  planWarnings,
  renderPlan,
} from './render'
export {
  readSecretFile,
  resolveApiUrl,
  resolveInstance,
  resolveTarget,
  type Target,
} from './target'
export { VERSION } from './version'

/**
 * The commands of `tula`. A new command is added here.
 *
 * @example
 * ```ts
 * await runCli(['diff'], io, COMMANDS)
 * ```
 */
export const COMMANDS: readonly Command[] = [
  diffCommand,
  applyCommand,
  doctorCommand,
  policyCommand,
  devCommand,
]

/**
 * Run `tula` with the process's own surroundings: its streams, environment and directory.
 *
 * @param argv - The arguments after `tula`.
 * @param overrides - Parts of the surroundings to replace (a test's streams, an in-process
 *   `fetch`).
 * @returns The exit code. The caller exits with it.
 *
 * @example
 * ```ts
 * process.exit(await main(process.argv.slice(2)))
 * ```
 */
export async function main(
  argv: readonly string[],
  overrides: Partial<CliIo> = {}
): Promise<number> {
  return runCli(argv, { ...processIo(), ...overrides }, COMMANDS)
}
