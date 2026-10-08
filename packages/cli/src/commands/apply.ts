import { basename, resolve } from 'node:path'
import { type AdminClient, ifMatch, isTulaAdminError } from '@tula/admin'
import { type EnvironmentConfig, providerSecret, resolveSecret } from '@tula/config'
import { MAX_WEBHOOK_URL_LENGTH } from '@tula/contract'
import { CONFIG_HASH_HEADER, CONFIG_MANAGED_BY_HEADER } from '@tula/contract/headers'
import { type OptionSpec, UsageError } from '../args'
import { MANAGING_TOOL, type Operation, orderOperations, type Plan, webhookSnapshot } from '../diff'
import { printable } from '../doctor'
import { type Command, type CommandContext, EXIT, reportError } from '../framework'
import type { Host } from '../host'
import {
  deletedAuditAge,
  describeOperation,
  OVER_LIMIT_ADVICE,
  planBlockers,
  planToJson,
  removedWebhooks,
  renderPlan,
  webhookCounts,
} from '../render'
import { PLAN_OPTIONS, prepare } from './shared'

const APPLY_OPTIONS = {
  ...PLAN_OPTIONS,
  yes: {
    type: 'boolean',
    short: 'y',
    description: 'Apply without asking. Required when not at a terminal (CI).',
  },
  'allow-unknown': {
    type: 'boolean',
    description:
      'Apply although the server has settings this version of tula does not know: they are reset to their defaults.',
  },
  'allow-weaker': {
    type: 'boolean',
    description: 'With --yes: apply although the plan weakens security (it is listed in the plan).',
  },
  'allow-webhook-removal': {
    type: 'boolean',
    description:
      'With --yes: apply although the plan removes a webhook endpoint (--prune), with its pending deliveries and its delivery log.',
  },
  'secrets-file': {
    type: 'string',
    value: '<path>',
    description:
      'Write the signing secret of each webhook endpoint the run creates to this new file (JSON, mode 0600). The server shows a secret only once.',
  },
  'show-secrets': {
    type: 'boolean',
    description: 'Print the signing secret of each webhook endpoint the run creates.',
  },
  'discard-secrets': {
    type: 'boolean',
    description:
      'Create webhook endpoints without keeping their signing secrets (rotate one later to get it).',
  },
  'expect-revision': {
    type: 'string',
    value: '<n>',
    description:
      'Apply only if the settings are still at this revision (the one `tula diff` printed).',
  },
} as const satisfies Record<string, OptionSpec>

/**
 * What the question at a terminal says first when the plan is one to think twice about.
 * A plan that sets or shortens the audit retention period says what it destroys, in those
 * words: "weakens security" alone would undersell a deletion that cannot be undone.
 */
function warningBeforeQuestion(plan: Plan): string {
  // A removed endpoint takes its record with it: said in the question, as a deletion is.
  const removed = removedWebhooks(plan)
  const removes = removed === null ? '' : `This REMOVES ${removed}, for good. `
  const paths = plan.weakened.join(', ')
  const doomed = deletedAuditAge(plan)
  if (doomed === null) {
    return `${paths ? `This WEAKENS security (${paths}). ` : ''}${removes}`
  }
  const deletes = `DELETES audit entries older than ${doomed} days, for good`
  return plan.weakened.length === 1
    ? `This ${deletes} (${paths}). ${removes}`
    : `This WEAKENS security (${paths}) and ${deletes}. ${removes}`
}

/** The signing secret of an endpoint a run created: what the server answered, once. */
interface CreatedSecret {
  id: string
  url: string
  secret: string
}

/** What the operator asked to be done with the secrets of the endpoints a run creates. */
interface SecretChoice {
  /** The file to write them to, as an absolute path. */
  file?: string
  /** Print them. */
  show: boolean
  /** Keep nothing. */
  discard: boolean
}

function secretChoice(context: CommandContext): SecretChoice {
  const { flags, io } = context
  const path = flags['secrets-file']
  const choice: SecretChoice = {
    file: typeof path === 'string' ? resolve(io.cwd, path) : undefined,
    show: flags['show-secrets'] === true,
    discard: flags['discard-secrets'] === true,
  }
  if (choice.discard && (choice.show || choice.file !== undefined)) {
    throw new UsageError(
      '--discard-secrets cannot be combined with --secrets-file or --show-secrets: keep the signing secrets or do not.'
    )
  }
  if (path === '-' || path === '') {
    throw new UsageError('--secrets-file takes the path of a new file.')
  }
  return choice
}

/** What a secrets file holds from the moment this run creates it until its first secret. */
const NO_SECRETS = '[]\n'

/**
 * The host, and an early look at the path, so that a run that cannot keep its secrets is
 * refused before the question is asked. Only a courtesy: what makes "a new file only" true
 * is the exclusive creation just before the first write (`Host.createSecretFile`).
 */
async function secretsHost(context: CommandContext, file: string): Promise<Host> {
  const host = context.io.host
  if (!host) {
    throw new UsageError('--secrets-file needs a file system, which this run does not have.')
  }
  let present: string | null
  try {
    // Refuses a link, a named pipe and a directory without opening them.
    present = await host.readFile(file)
  } catch (error) {
    if (error instanceof UsageError) {
      throw new UsageError(`--secrets-file: ${error.message} Nothing was changed.`)
    }
    throw error
  }
  // Whatever it holds, an empty list included: it is somebody's file.
  if (present !== null) {
    throw new UsageError(
      `--secrets-file: ${basename(file)} already exists. It may hold the signing secrets of an earlier run, which are shown only once: name a file that does not exist. Nothing was changed.`
    )
  }
  return host
}

const NEEDS_SECRET_CHOICE = (created: number) =>
  `This plan creates ${created} webhook ${created === 1 ? 'endpoint' : 'endpoints'}, and the server shows ` +
  `${created === 1 ? 'its signing secret' : 'each signing secret'} only once, in its answer to this run. ` +
  `Nothing was changed. Say what to do with ${created === 1 ? 'it' : 'them'}:\n` +
  '  --secrets-file <path>  write to a new file only you can read (mode 0600)\n' +
  '  --show-secrets         print on standard output\n' +
  '  --discard-secrets      keep nothing. To get a secret later, rotate it: for the 24 hours of ' +
  'the overlap deliveries are then also signed with the first secret, which nobody holds. That is harmless.'

/** Thrown inside the run when the endpoints are no longer what the plan read. */
class StaleWebhooks extends Error {}

/** Thrown inside the run when the endpoints could not be read again: no write was tried. */
class UnreadWebhooks extends Error {
  constructor(readonly reason: unknown) {
    super('the webhook endpoints could not be read again')
  }
}

const UNREAD_WEBHOOKS =
  'The webhook endpoints could not be read again before the first write to them, so nothing ' +
  'was written to them.'

const STALE_WEBHOOKS =
  'The webhook endpoints were changed by someone else after this plan was made. Nothing was ' +
  'written to them. Run `tula diff` again and review the new plan.'

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

/** The body of a webhook write: what the file says, and for a change only what differs. */
function webhookBody(
  environment: EnvironmentConfig,
  operation: Extract<Operation, { kind: 'webhook.create' | 'webhook.update' }>
) {
  const desired = environment.webhooks?.find((endpoint) => endpoint.url === operation.url)
  if (!desired) {
    throw new Error('a webhook operation has no entry in the config')
  }
  const changed = (path: string) => operation.change.fields.some((field) => field.path === path)
  return {
    desired,
    update: {
      ...(changed('eventTypes') && { eventTypes: desired.eventTypes }),
      ...(changed('enabled') && { enabled: desired.enabled }),
    },
  }
}

async function runWebhookOperation(
  admin: AdminClient,
  environment: EnvironmentConfig,
  operation: Extract<Operation, { kind: `webhook.${string}` }>
): Promise<CreatedSecret | undefined> {
  if (operation.kind === 'webhook.delete') {
    await admin.call('deleteWebhookEndpoint', { params: { id: operation.id } })
    return undefined
  }
  const { desired, update } = webhookBody(environment, operation)
  if (operation.kind === 'webhook.update') {
    await admin.call('updateWebhookEndpoint', { params: { id: operation.id }, body: update })
    return undefined
  }
  const answer = await admin.call('createWebhookEndpoint', {
    body: {
      url: desired.url,
      eventTypes: desired.eventTypes,
      // Left out of the file, the switch is the server's to default.
      ...(desired.enabled !== undefined && { enabled: desired.enabled }),
    },
  })
  return { id: answer.data.id, url: desired.url, secret: answer.data.secret }
}

async function runOperation(
  admin: AdminClient,
  plan: Plan,
  environment: EnvironmentConfig,
  secrets: ReadonlyMap<string, string>,
  operation: Exclude<Operation, { kind: `webhook.${string}` }>
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
  if (operation.provider === 'microsoft') {
    const microsoft = environment.providers.microsoft
    if (microsoft) {
      await admin.call('updateOAuthProvider', {
        params: { provider: 'microsoft' },
        body: {
          clientId: microsoft.clientId,
          tenant: microsoft.tenant,
          enabled: microsoft.enabled,
          ...(secret !== undefined && { clientSecret: secret }),
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
 * refuses two plans unless told otherwise: one that would reset settings this version does not
 * know (`--allow-unknown`), and, under `--yes`, where nobody reads the warning, one that
 * weakens security (`--allow-weaker`) or removes a webhook endpoint
 * (`--allow-webhook-removal`). A plan that creates a webhook endpoint needs a word on its
 * signing secret, which the server shows once (`--secrets-file`, `--show-secrets`,
 * `--discard-secrets`); the secret is redacted from all output unless it was asked for. It
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
    'tula apply [--env <name>] [--config <path>] [--yes] [--prune] [--rotate-secrets] [--expect-revision <n>] [--allow-unknown] [--allow-weaker] [--allow-webhook-removal] [--secrets-file <path> | --show-secrets | --discard-secrets] [--json]',
  description:
    'Prints the plan, asks for confirmation, then replaces the environment’s settings (only if ' +
    'nobody changed them since the plan was made) and creates, updates or deletes OAuth ' +
    'providers and, when the file lists them, webhook endpoints. Provider secrets are read ' +
    'from the environment variables the config names. A new webhook endpoint’s signing secret ' +
    'is made by the server and shown once: the run needs --secrets-file, --show-secrets or ' +
    '--discard-secrets.\n\n' +
    'It refuses a plan that would reset settings this version of tula does not know (unless ' +
    '--allow-unknown), and with --yes a plan that weakens security (unless --allow-weaker) or ' +
    'removes a webhook endpoint (unless --allow-webhook-removal).\n\n' +
    'Exit codes: 0 applied (or nothing to do), 1 an error or a declined confirmation.',
  options: APPLY_OPTIONS,
  run: async (context) => {
    const { flags, io, output } = context
    const json = flags.json === true
    const expected = expectedRevision(flags['expect-revision'])
    // Standard input can carry the key or the answer to the question, not both. Said before
    // anything is read, so the key is not consumed by a run that cannot finish.
    if (flags['secret-key-file'] === '-' && flags.yes !== true) {
      throw new UsageError(
        'The secret key is read from standard input, so standard input cannot also answer the ' +
          'confirmation: pass --yes as well. Nothing was read or changed.'
      )
    }
    const choice = secretChoice(context)
    const { name, environment, target, plan } = await prepare(context)
    const header = { environment: name, apiUrl: target.apiUrl }
    if (!json) {
      renderPlan(output, header, plan)
    }
    const operations = orderOperations(plan)
    const created: CreatedSecret[] = []
    /** Endpoints that exist and whose secret could be put nowhere: never the secret itself. */
    const notKept: { id: string; url: string }[] = []
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
              ...(choice.file !== undefined && created.length > 0 && { secretsFile: choice.file }),
              ...(notKept.length > 0 && { secretsNotKept: notKept }),
              // Only because it was asked for: the one place a secret is ever printed.
              ...(choice.show && { webhookSecrets: created }),
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
    // A plan no run can carry out: an address the server has twice, or too many endpoints.
    // Before "no changes" (an address that cannot be matched plans no write of its own).
    const blockers = planBlockers(plan)
    for (const blocker of blockers) {
      const advice = blocker.includes('may have') ? ` ${OVER_LIMIT_ADVICE}` : ''
      output.error(`${output.errorStyle.red('error:')} ${blocker} Nothing was changed.${advice}`)
    }
    if (blockers.length > 0) {
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

    // The replace sends the whole document as this version knows it: a setting a newer server
    // has would silently go back to its default. Never without being asked to, --yes or not.
    if (plan.unknown.length > 0 && flags['allow-unknown'] !== true) {
      output.error(
        `${output.errorStyle.red('error:')} The server has settings this version of tula does ` +
          `not know (${plan.unknown.join(', ')}); applying would reset them to their defaults. ` +
          'Nothing was changed. Upgrade tula, or pass --allow-unknown to reset them.'
      )
      return EXIT.error
    }
    // With --yes nobody reads the plan's warning, so a weakening needs its own word.
    if (flags.yes === true && plan.weakened.length > 0 && flags['allow-weaker'] !== true) {
      output.error(
        `${output.errorStyle.red('error:')} This plan weakens security ` +
          `(${plan.weakened.join(', ')}), and with --yes nobody is asked. Nothing was changed. ` +
          'Pass --allow-weaker with --yes to apply it.'
      )
      return EXIT.error
    }

    // A removed endpoint takes its pending deliveries and its delivery log with it. "Weakens
    // security" would not be the word for it, so it has a flag of its own.
    const removed = removedWebhooks(plan)
    if (flags.yes === true && removed !== null && flags['allow-webhook-removal'] !== true) {
      output.error(
        `${output.errorStyle.red('error:')} This plan removes ${removed}, for good, and with ` +
          '--yes nobody is asked. Nothing was changed. Pass --allow-webhook-removal with --yes ' +
          'to apply it.'
      )
      return EXIT.error
    }
    // The server answers a new endpoint's secret once. A run that was not told what to do
    // with it would throw it away without a word, or print it without being asked: neither.
    const creating = webhookCounts(plan).created
    if (creating > 0 && !choice.show && !choice.discard && choice.file === undefined) {
      output.error(`${output.errorStyle.red('error:')} ${NEEDS_SECRET_CHOICE(creating)}`)
      return EXIT.error
    }
    const secretsFile =
      creating > 0 && choice.file !== undefined
        ? { path: choice.file, host: await secretsHost(context, choice.file) }
        : undefined

    // Before the question and before any write: a run that cannot finish must not start.
    const secrets = resolveSecrets(context, environment, operations)

    if (flags.yes !== true) {
      if (!io.isTTY || !io.prompt) {
        throw new UsageError(
          'Not at a terminal, so there is nobody to confirm: pass --yes to apply without asking. Nothing was changed.'
        )
      }
      const answer = await io.prompt(
        `${warningBeforeQuestion(plan)}Apply these changes to "${name}" at ${target.apiUrl}? Type yes to continue: `
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

    // What this run last wrote to its secrets file. The file is this run's from its exclusive
    // creation, and stays so only while it still holds exactly this: before every rewrite it
    // is read back, and a file that holds anything else (somebody replaced it) is not
    // written over. That check and the rewrite are two steps, so a replacement made between
    // them is not protected; the creation itself is one step and is.
    let inFile = NO_SECRETS
    /** How many of `created` are in the file. */
    let written = 0
    const keep = async (file: { host: Host; path: string }) => {
      if ((await file.host.readFile(file.path)) !== inFile) {
        throw new Error('the secrets file is no longer the one this run created')
      }
      const next = `${JSON.stringify(created, null, 2)}\n`
      await file.host.writeSecretFile(file.path, next)
      inFile = next
      written = created.length
    }
    // The file is claimed before the first write: where it cannot be created, the run must
    // fail now and not with a secret in its hands. Exclusive, so nothing already at the path
    // (a file, a link, a pipe; put there a moment ago or long before) is ever replaced.
    if (secretsFile) {
      try {
        await secretsFile.host.createSecretFile(secretsFile.path, NO_SECRETS)
      } catch (error) {
        const why = error instanceof UsageError ? error.message : 'It could not be created.'
        output.error(
          `${output.errorStyle.red('error:')} --secrets-file: ${why} Nothing was changed.`
        )
        return EXIT.error
      }
    }
    /** A file this run created and put nothing into is not left behind. */
    const release = async () => {
      if (!secretsFile || written > 0) {
        return
      }
      try {
        if ((await secretsFile.host.readFile(secretsFile.path)) === NO_SECRETS) {
          await secretsFile.host.removeFile(secretsFile.path)
        }
      } catch {
        // Not this run's any more, or not removable: an empty list is all that is left.
      }
    }
    /** Where the kept secrets are, or that none were kept: said however the run ends. */
    const secretsNote = (say: (text: string) => void) => {
      const signing = (count: number) => `${count} signing ${count === 1 ? 'secret' : 'secrets'}`
      if (secretsFile && written > 0) {
        say(
          `Wrote ${signing(written)} to ${secretsFile.path} (mode 0600). It is not shown again: give it to the receiver, then delete the file.`
        )
      } else if (choice.discard && created.length > 0) {
        say(
          `${signing(created.length)} ${created.length === 1 ? 'was' : 'were'} not kept (--discard-secrets). To get one, rotate it: POST /v1/admin/webhook-endpoints/<id>/secret/rotate.`
        )
      }
    }

    const applied: Operation[] = []
    let revision = plan.revision
    let webhooksChecked = false
    /** What was and was not applied, the note on the secrets, and the run's failing end. */
    const stop = async (failed: Operation | undefined): Promise<number> => {
      const notApplied = operations.slice(applied.length)
      if (applied.length > 0) {
        output.error('Applied before the failure:')
        for (const done of applied) {
          output.error(`  ${describeOperation(done)}`)
        }
      }
      if (notApplied.length > 0) {
        output.error('Not applied:')
        for (const pending of notApplied) {
          output.error(`  ${describeOperation(pending)}`)
        }
      }
      if (applied.length > 0 && notApplied.length > 0) {
        output.error('Run `tula apply` again to finish: it starts from what the server has now.')
      }
      secretsNote((text) => output.error(text))
      await release()
      report(applied, failed, revision)
      return EXIT.error
    }
    for (const operation of operations) {
      /** An endpoint this operation created whose secret could not be put in the file. */
      let unkept: CreatedSecret | undefined
      try {
        if (
          operation.kind === 'webhook.create' ||
          operation.kind === 'webhook.update' ||
          operation.kind === 'webhook.delete'
        ) {
          // Endpoints have no revision to make a write conditional on. So they are read once
          // more, as late as possible, and the run stops if they are not what the plan read.
          // This narrows the window to the run's own writes; it does not close it.
          if (!webhooksChecked) {
            const now = await target.admin.call('listWebhookEndpoints').catch((reason) => {
              // Not a failure of this operation: it was never tried.
              throw new UnreadWebhooks(reason)
            })
            if (webhookSnapshot(now.data.data) !== plan.webhooks.seen) {
              throw new StaleWebhooks()
            }
            webhooksChecked = true
          }
          const made = await runWebhookOperation(target.admin, environment, operation)
          if (made) {
            // Before anything else can print: unless it was asked for, no line of this run
            // may carry it, whatever goes wrong next.
            if (!choice.show) {
              output.redact(made.secret)
            }
            created.push(made)
            if (secretsFile) {
              // The endpoint exists whatever happens to the file: a failure here is said as
              // what it is, below, and never as a failed creation.
              await keep(secretsFile).catch(() => {
                unkept = made
              })
            }
          }
        } else {
          revision =
            (await runOperation(target.admin, plan, environment, secrets, operation)) ?? revision
        }
      } catch (error) {
        const stale =
          operation.kind === 'settings' &&
          isTulaAdminError(error) &&
          error.code === 'precondition.failed'
        if (stale) {
          output.error(`${output.errorStyle.red('error:')} ${STALE}`)
        } else if (error instanceof StaleWebhooks) {
          output.error(`${output.errorStyle.red('error:')} ${STALE_WEBHOOKS}`)
        } else if (error instanceof UnreadWebhooks) {
          output.error(`${output.errorStyle.red('error:')} ${UNREAD_WEBHOOKS}`)
          reportError(output, error.reason)
        } else {
          output.error(`Failed: ${describeOperation(operation)}`)
          // The API's own account of why, with the field paths of a validation error.
          reportError(output, error)
          // For an address the server will not call, its fixed word for which rule: all it
          // gives, and nothing of the address or of what its name resolved to.
          const reason = isTulaAdminError(error) ? error.params.reason : undefined
          if (operation.kind === 'webhook.create' && typeof reason === 'string') {
            output.error(`  reason: ${printable(reason, 60)}`)
          }
        }
        return stop(operation)
      }
      applied.push(operation)
      if (!json) {
        output.line(output.style.green(`  done  ${describeOperation(operation)}`))
        const made = operation.kind === 'webhook.create' ? created.at(-1) : undefined
        if (made && choice.show) {
          output.line(`        signing secret, shown this once: ${made.secret}`)
        }
      }
      if (unkept !== undefined && secretsFile) {
        const lost: CreatedSecret = unkept
        notKept.push({ id: lost.id, url: lost.url })
        output.error(
          `${output.errorStyle.red('error:')} The webhook endpoint ${printable(lost.url, MAX_WEBHOOK_URL_LENGTH)} was created, but its signing secret could not be written to ${secretsFile.path}: it was not kept. ` +
            `To get one, rotate it: POST /v1/admin/webhook-endpoints/${printable(lost.id, 40)}/secret/rotate.`
        )
        return stop(undefined)
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
      secretsNote((text) => output.line(text))
    }
    await release()
    return EXIT.ok
  },
}
