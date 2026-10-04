import { type AdminClient, ifMatch, isTulaAdminError } from '@tula/admin'
import { type EnvironmentConfig, providerSecret, resolveSecret } from '@tula/config'
import { CONFIG_HASH_HEADER, CONFIG_MANAGED_BY_HEADER } from '@tula/contract/headers'
import { type OptionSpec, UsageError } from '../args'
import { MANAGING_TOOL, type Operation, orderOperations, type Plan } from '../diff'
import { type Command, type CommandContext, EXIT, reportError } from '../framework'
import { describeOperation, planToJson, renderPlan } from '../render'
import { PLAN_OPTIONS, prepare } from './shared'

const APPLY_OPTIONS = {
  ...PLAN_OPTIONS,
  yes: {
    type: 'boolean',
    short: 'y',
    description: 'Apply without asking. Required when not at a terminal (CI).',
  },
  'expect-revision': {
    type: 'string',
    value: '<n>',
    description:
      'Apply only if the settings are still at this revision (the one `tula diff` printed).',
  },
} as const satisfies Record<string, OptionSpec>

/** The secrets a run will write, read from the environment before anything is changed. */
function resolveSecrets(
  context: CommandContext,
  environment: EnvironmentConfig,
  operations: readonly Operation[]
): Map<string, string> {
  const secrets = new Map<string, string>()
  for (const operation of operations) {
    if (operation.kind === 'provider.set' && operation.change.secret === 'set') {
      const ref = providerSecret(environment.providers, operation.provider)
      if (ref) {
        const value = resolveSecret(ref, context.io.env)
        context.output.redact(value)
        secrets.set(operation.provider, value)
      }
    }
  }
  return secrets
}

async function runOperation(
  admin: AdminClient,
  plan: Plan,
  environment: EnvironmentConfig,
  secrets: ReadonlyMap<string, string>,
  operation: Operation
): Promise<number | undefined> {
  if (operation.kind === 'settings') {
    const answer = await admin.call('replaceEnvironmentSettings', {
      headers: {
        'If-Match': ifMatch(plan.revision),
        // Record this config as the settings' manager, on a server that keeps such a record.
        ...(plan.marker.supported && {
          [CONFIG_MANAGED_BY_HEADER]: MANAGING_TOOL,
          [CONFIG_HASH_HEADER]: plan.marker.configHash,
        }),
      },
      body: plan.body,
    })
    return answer.data.revision
  }
  if (operation.kind === 'provider.delete') {
    await admin.call('deleteOAuthProvider', { params: { provider: operation.provider } })
    return undefined
  }
  const secret = secrets.get(operation.provider)
  if (operation.provider === 'apple') {
    const apple = environment.providers.apple
    if (apple) {
      await admin.call('updateOAuthProvider', {
        params: { provider: 'apple' },
        body: {
          clientId: apple.clientId,
          teamId: apple.teamId,
          keyId: apple.keyId,
          enabled: apple.enabled,
          ...(secret !== undefined && { privateKey: secret }),
        },
      })
    }
    return undefined
  }
  const client = environment.providers[operation.provider]
  if (client) {
    await admin.call('updateOAuthProvider', {
      params: { provider: operation.provider },
      body: {
        clientId: client.clientId,
        enabled: client.enabled,
        ...(secret !== undefined && { clientSecret: secret }),
      },
    })
  }
  return undefined
}

function expectedRevision(flag: string | boolean | undefined): number | undefined {
  if (flag === undefined) {
    return undefined
  }
  if (typeof flag !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(flag)) {
    throw new UsageError('--expect-revision takes a revision number, e.g. --expect-revision 7.')
  }
  return Number(flag)
}

const STALE =
  'The settings were changed by someone else after this plan was made. Nothing was written to ' +
  'the settings. Run `tula diff` again and review the new plan.'

/**
 * `tula apply`: make an environment's settings and providers what the config file says.
 *
 * It prints the same plan as `tula diff`, asks before changing anything (`--yes` skips the
 * question; without it a run that is not at a terminal refuses instead of hanging), and
 * replaces the settings with `If-Match` on the revision the plan was made against, so a change
 * someone else made in between is never overwritten. If a write fails part-way, it says
 * exactly what was applied and what was not; running it again finishes the job.
 *
 * @example
 * ```sh
 * TULA_API_URL=https://auth.example.com TULA_SECRET_KEY=… tula apply --env prod --yes
 * ```
 */
export const applyCommand: Command = {
  name: 'apply',
  summary: 'Make the environment what tula.config.ts says.',
  usage:
    'tula apply [--env <name>] [--config <path>] [--yes] [--prune] [--rotate-secrets] [--expect-revision <n>] [--json]',
  description:
    'Prints the plan, asks for confirmation, then replaces the environment’s settings (only if ' +
    'nobody changed them since the plan was made) and creates, updates or deletes OAuth ' +
    'providers. Provider secrets are read from the environment variables the config names.\n\n' +
    'Exit codes: 0 applied (or nothing to do), 1 an error or a declined confirmation.',
  options: APPLY_OPTIONS,
  run: async (context) => {
    const { flags, io, output } = context
    const json = flags.json === true
    const expected = expectedRevision(flags['expect-revision'])
    const { name, environment, target, plan } = await prepare(context)
    const header = { environment: name, apiUrl: target.apiUrl }
    if (!json) {
      renderPlan(output, header, plan)
    }
    const operations = orderOperations(plan)
    const report = (applied: Operation[], failed: Operation | undefined, revision: number) => {
      if (json) {
        const notApplied = operations.slice(applied.length + (failed ? 1 : 0))
        output.line(
          JSON.stringify(
            {
              ...planToJson(header, plan),
              applied: applied.map(describeOperation),
              failed: failed ? describeOperation(failed) : null,
              notApplied: notApplied.map(describeOperation),
              revisionAfter: revision,
            },
            null,
            2
          )
        )
      }
    }

    if (expected !== undefined && expected !== plan.revision) {
      output.error(
        `${output.errorStyle.red('error:')} The settings are at revision ${plan.revision}, not ` +
          `${expected}: they were changed after that plan was made. Nothing was changed. Run ` +
          '`tula diff` again and review the new plan.'
      )
      return EXIT.error
    }
    if (operations.length === 0) {
      if (json) {
        report([], undefined, plan.revision)
      } else {
        output.line('No changes: the environment is as the config says.')
      }
      return EXIT.ok
    }

    // Before the question and before any write: a run that cannot finish must not start.
    const secrets = resolveSecrets(context, environment, operations)

    if (flags.yes !== true) {
      if (!io.isTTY || !io.prompt) {
        throw new UsageError(
          'Not at a terminal, so there is nobody to confirm: pass --yes to apply without asking. Nothing was changed.'
        )
      }
      const answer = await io.prompt(
        `Apply these changes to "${name}" at ${target.apiUrl}? Type yes to continue: `
      )
      if (answer.trim().toLowerCase() !== 'yes') {
        output.error('Cancelled. Nothing was changed.')
        return EXIT.error
      }
    }

    // When providers have to be written before the settings (the file switches every native
    // sign-in method off), a stale revision would only show at the replace, after a provider
    // was already written. Look once more first; the replace's If-Match remains the guarantee.
    if (operations[0]?.kind !== 'settings' && operations.some((op) => op.kind === 'settings')) {
      const now = await target.admin.call('getEnvironmentSettings')
      if (now.data.revision !== plan.revision) {
        output.error(`${output.errorStyle.red('error:')} ${STALE}`)
        return EXIT.error
      }
    }

    const applied: Operation[] = []
    let revision = plan.revision
    for (const operation of operations) {
      try {
        revision =
          (await runOperation(target.admin, plan, environment, secrets, operation)) ?? revision
      } catch (error) {
        const stale =
          operation.kind === 'settings' &&
          isTulaAdminError(error) &&
          error.code === 'precondition.failed'
        if (stale) {
          output.error(`${output.errorStyle.red('error:')} ${STALE}`)
        } else {
          output.error(`Failed: ${describeOperation(operation)}`)
          // The API's own account of why, with the field paths of a validation error.
          reportError(output, error)
        }
        const notApplied = operations.slice(applied.length + 1)
        if (applied.length > 0) {
          output.error('Applied before the failure:')
          for (const done of applied) {
            output.error(`  ${describeOperation(done)}`)
          }
        }
        output.error('Not applied:')
        for (const pending of [operation, ...notApplied]) {
          output.error(`  ${describeOperation(pending)}`)
        }
        if (applied.length > 0) {
          output.error('Run `tula apply` again to finish: it starts from what the server has now.')
        }
        report(applied, operation, revision)
        return EXIT.error
      }
      applied.push(operation)
      if (!json) {
        output.line(output.style.green(`  done  ${describeOperation(operation)}`))
      }
    }
    if (json) {
      report(applied, undefined, revision)
    } else {
      output.line()
      output.line(
        `Applied ${applied.length} ${applied.length === 1 ? 'change' : 'changes'}. ` +
          `Settings are at revision ${revision}.`
      )
    }
    return EXIT.ok
  },
}
