import { type Command, EXIT } from '../framework'
import { planToJson, renderPlan } from '../render'
import { PLAN_OPTIONS, prepare } from './shared'

/**
 * `tula diff`: compare the config file with what the server has and print the plan. It writes
 * nothing. Exit code `0` when there is nothing to apply, `2` when there is, `1` on an error,
 * so a CI job can gate on it.
 *
 * @example
 * ```sh
 * tula diff --env prod || [ $? -eq 2 ]   # 2 = changes pending
 * ```
 */
export const diffCommand: Command = {
  name: 'diff',
  summary: 'Show what `tula apply` would change. Writes nothing.',
  usage: 'tula diff [--env <name>] [--config <path>] [--prune] [--json]',
  description:
    'Compares tula.config.ts with the environment’s settings and OAuth providers and prints ' +
    'the plan: what would be added, changed and removed, by path. Secrets are never shown.\n\n' +
    'Exit codes: 0 no changes, 2 changes pending, 1 an error.',
  options: PLAN_OPTIONS,
  run: async (context) => {
    const { name, target, plan } = await prepare(context)
    const header = { environment: name, apiUrl: target.apiUrl }
    if (context.flags.json) {
      context.output.line(JSON.stringify(planToJson(header, plan), null, 2))
    } else {
      renderPlan(context.output, header, plan)
      context.output.line(
        plan.changes
          ? 'Changes pending. Run `tula apply` to make them.'
          : 'No changes: the environment is as the config says.'
      )
    }
    return plan.changes ? EXIT.changes : EXIT.ok
  },
}
