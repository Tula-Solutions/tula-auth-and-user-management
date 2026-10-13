import { type Command, EXIT } from '../framework'
import {
  applyRequirements,
  OVER_LIMIT_ADVICE,
  planBlockers,
  planToJson,
  renderPlan,
} from '../render'
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
  usage: 'tula diff [--env <name>] [--config <path>] [--prune] [--rotate-secrets] [--json]',
  description:
    'Compares tula.config.ts with the environment’s settings, OAuth providers and (when the ' +
    'file lists them) webhook endpoints and hooks, and prints the plan: what would be added, changed ' +
    'and removed, by path. Secrets are never shown.\n\n' +
    'Exit codes: 0 no changes, 2 changes pending, 1 an error. A plan that cannot be ' +
    'applied (a webhook address the server has twice, too many endpoints) is an error.',
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
      const needs = applyRequirements(plan)
      if (needs.allowUnknown) {
        context.output.line(
          '`tula apply` refuses this plan without --allow-unknown: it would reset settings this version does not know.'
        )
      }
      if (needs.allowWeaker) {
        context.output.line(
          '`tula apply --yes` refuses this plan without --allow-weaker: it weakens security.'
        )
      }
      if (needs.allowWebhookRemoval) {
        context.output.line(
          '`tula apply --yes` refuses this plan without --allow-webhook-removal: it removes a webhook endpoint and its delivery log.'
        )
      }
    }
    // A plan no run can carry out is not "changes pending": it is an error to put right.
    const blockers = planBlockers(plan)
    for (const blocker of blockers) {
      const advice =
        plan.webhooks.overLimit !== null && blocker.includes('may have')
          ? ` ${OVER_LIMIT_ADVICE}`
          : ''
      context.output.error(`${context.output.errorStyle.red('error:')} ${blocker}${advice}`)
    }
    if (blockers.length > 0) {
      return EXIT.error
    }
    return plan.changes ? EXIT.changes : EXIT.ok
  },
}
