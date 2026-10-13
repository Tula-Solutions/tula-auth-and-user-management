import { applyCommand } from './commands/apply'
import { approveCommand } from './commands/approve'
import { devCommand } from './commands/dev'
import { diffCommand } from './commands/diff'
import { doctorCommand } from './commands/doctor'
import { mcpCommand } from './commands/mcp'
import { policyCommand } from './commands/policy'
import { type CliIo, type Command, runCli } from './framework'
import { processIo } from './process-io'

export { type OptionSpec, type ParsedArgs, parseArgs, UsageError } from './args'
export { applyCommand } from './commands/apply'
export { approveCommand } from './commands/approve'
export { devCommand } from './commands/dev'
export { diffCommand } from './commands/diff'
export { doctorCommand } from './commands/doctor'
export { buildMcpServer, mcpCommand } from './commands/mcp'
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
  DEPENDENTS_UNREAD,
  type DependentCount,
  diffValues,
  type KnownDependents,
  MANAGING_TOOL,
  type MarkerPlan,
  type Operation,
  orderOperations,
  type Plan,
  type PlanOptions,
  type ProviderChange,
  planProviders,
  providersGoingOff,
  type RemoteDependents,
  type RemoteProvider,
  type RemoteState,
  readDependentCount,
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
  resolveAgent,
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
  mcpCommand,
  approveCommand,
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
