import {
  MAX_EMAIL_BODY_LENGTH,
  MAX_WEBHOOK_ENDPOINTS,
  MAX_WEBHOOK_URL_LENGTH,
} from '@tula/contract'
import {
  type Change,
  type HookChange,
  isTemplatePath,
  type Operation,
  type Plan,
  type ProviderChange,
  type WebhookChange,
} from './diff'
import { printable } from './doctor'
import type { Output } from './output'

/** Longest a value is shown before it is cut: a plan is read by a person. */
const MAX_VALUE_LENGTH = 100

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined'
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text
}

/**
 * A setting's value as a plan shows it. A template's text (an email's subject or body, a
 * text message's sentence) is long free
 * text, and the one on the server is not this file's: it goes through `printable()` first,
 * so nothing a reader cannot see reaches the terminal, and is cut like any other value.
 */
function shown(change: Change, value: unknown): string {
  return typeof value === 'string' && isTemplatePath(change.path)
    ? show(printable(value, MAX_EMAIL_BODY_LENGTH))
    : show(value)
}

function settingLine(output: Output, change: Change): string {
  const { style } = output
  if (change.kind === 'added') {
    return style.green(`  + ${change.path}: ${shown(change, change.after)}`)
  }
  if (change.kind === 'removed') {
    const note = isTemplatePath(change.path) ? ' (the built-in copy is sent)' : ''
    return style.red(`  - ${change.path}: ${shown(change, change.before)}${note}`)
  }
  if (change.added || change.removed) {
    const entries = [
      ...(change.added ?? []).map((entry) => `+${show(entry)}`),
      ...(change.removed ?? []).map((entry) => `-${show(entry)}`),
    ]
    return style.yellow(`  ~ ${change.path}: ${entries.join(' ')}`)
  }
  return style.yellow(
    `  ~ ${change.path}: ${shown(change, change.before)} → ${shown(change, change.after)}`
  )
}

/** What happens to a provider's secret, in words. Never the secret. */
function secretNote(change: ProviderChange): string {
  if (change.secret === 'set') {
    return `secret set from $${change.secretEnv ?? '?'}`
  }
  return change.secret === 'keep' ? 'stored secret kept' : ''
}

function providerLine(output: Output, change: ProviderChange): string {
  const { style } = output
  const fields = change.fields.map((field) =>
    field.kind === 'changed'
      ? `${field.path} ${show(field.before)} → ${show(field.after)}`
      : `${field.path} ${show(field.after)}`
  )
  const details = [...fields, secretNote(change)].filter((part) => part !== '').join(', ')
  const suffix = details === '' ? '' : ` (${details})`
  switch (change.action) {
    case 'create':
      return style.green(`  + ${change.provider}: create${suffix}`)
    case 'update':
      return style.yellow(`  ~ ${change.provider}: update${suffix}`)
    case 'delete':
      return style.red(`  - ${change.provider}: delete`)
    case 'unmanaged':
      return style.dim(
        `  = ${change.provider}: unmanaged (on the server, not in the file; --prune deletes it)`
      )
    default:
      return style.dim(`  = ${change.provider}: unchanged`)
  }
}

/**
 * An endpoint's address for a person. Whole (two endpoints may differ in their last
 * character), and, since it may be one the server sent, with nothing a terminal would act on
 * and nothing a reader cannot see.
 */
function address(url: string): string {
  return printable(url, MAX_WEBHOOK_URL_LENGTH)
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/** `1 webhook endpoint with its pending deliveries and its delivery log`, or the plural. */
function removedEndpoints(count: number): string {
  return `${count} webhook ${plural(count, 'endpoint with its', 'endpoints with their')} pending deliveries and ${plural(count, 'its delivery log', 'their delivery logs')}`
}

function webhookFields(change: WebhookChange): string[] {
  return change.fields.map((field) => {
    if (field.path === 'eventTypes') {
      const entries =
        field.kind === 'added'
          ? (field.after as unknown[]).map((entry) => show(entry))
          : [
              ...(field.added ?? []).map((entry) => `+${show(entry)}`),
              ...(field.removed ?? []).map((entry) => `-${show(entry)}`),
            ]
      return `eventTypes ${entries.join(' ')}`
    }
    if (field.kind === 'added') {
      return `${field.path} ${show(field.after)}`
    }
    const why =
      change.reenables === undefined
        ? ''
        : ` (the server had switched it off: ${printable(change.reenables, 60)})`
    return `${field.path} ${show(field.before)} → ${show(field.after)}${why}`
  })
}

function webhookLine(output: Output, change: WebhookChange): string {
  const { style } = output
  const url = address(change.url)
  const fields = webhookFields(change).join(', ')
  switch (change.action) {
    case 'create':
      return style.green(`  + ${url}: create (${fields}; a signing secret is made, shown once)`)
    case 'update':
      return style.yellow(`  ~ ${url}: update (${fields})`)
    case 'delete':
      return style.red(`  - ${url}: remove, with its pending deliveries and its delivery log`)
    case 'unmanaged':
      return style.dim(
        `  = ${url}: unmanaged (on the server, not in the file; --prune removes it, with its pending deliveries and its delivery log)`
      )
    case 'ambiguous':
      return style.red(
        `  ! ${url}: cannot be matched (the server has ${change.duplicates?.length ?? 0} endpoints with this address)`
      )
    default:
      return style.dim(`  = ${url}: unchanged`)
  }
}

/** A hook's point for a person: one of the contract's, or whatever a later server sent. */
function pointName(point: string): string {
  return printable(point, 60)
}

function hookFields(change: HookChange): string[] {
  return change.fields.map((field) => {
    // An address is shown whole and as it is, like an endpoint's; the server's through
    // `printable()`, which is what `address` does.
    const value = (entry: unknown) => (field.path === 'url' ? address(String(entry)) : show(entry))
    return field.kind === 'added'
      ? `${field.path} ${value(field.after)}`
      : `${field.path} ${value(field.before)} → ${value(field.after)}`
  })
}

function hookLine(output: Output, change: HookChange): string {
  const { style } = output
  const point = pointName(change.point)
  const fields = hookFields(change).join(', ')
  switch (change.action) {
    case 'create':
      return style.green(`  + ${point}: create (${fields}; a signing secret is made, shown once)`)
    case 'update':
      return style.yellow(`  ~ ${point}: update (${fields})`)
    case 'delete':
      return style.red(`  - ${point}: remove (${address(change.url)}), with its signing secret`)
    case 'unmanaged':
      return style.dim(
        `  = ${point}: unmanaged (on the server, not in the file; --prune removes it)`
      )
    case 'unknown':
      return style.dim(
        `  = ${point}: a point this version of tula does not know (left alone, also with --prune)`
      )
    default:
      return style.dim(`  = ${point}: unchanged`)
  }
}

/**
 * How many hooks a plan creates and removes.
 *
 * @param plan - The plan.
 * @returns The two counts.
 *
 * @example
 * ```ts
 * hookCounts(plan) // { created: 1, removed: 0 }
 * ```
 */
export function hookCounts(plan: Pick<Plan, 'hooks'>): { created: number; removed: number } {
  const count = (action: HookChange['action']) =>
    plan.hooks.hooks.filter((hook) => hook.action === action).length
  return { created: count('create'), removed: count('delete') }
}

/**
 * How many webhook endpoints a plan creates and removes.
 *
 * @param plan - The plan.
 * @returns The two counts.
 *
 * @example
 * ```ts
 * webhookCounts(plan) // { created: 1, removed: 0 }
 * ```
 */
export function webhookCounts(plan: Pick<Plan, 'webhooks'>): { created: number; removed: number } {
  const count = (action: WebhookChange['action']) =>
    plan.webhooks.endpoints.filter((endpoint) => endpoint.action === action).length
  return { created: count('create'), removed: count('delete') }
}

/**
 * Why a plan cannot be applied at all, whatever flags a run is given: an address the server
 * has more than once (which endpoint the file means cannot be known), or more endpoints than
 * an environment may have. `tula diff` fails on these and `tula apply` writes nothing.
 *
 * @param plan - The plan.
 * @returns One sentence per reason; empty when the plan can be applied.
 *
 * @example
 * ```ts
 * planBlockers(plan) // ['The environment would have 11 webhook endpoints and may have 10.']
 * ```
 */
export function planBlockers(plan: Pick<Plan, 'webhooks'>): string[] {
  const blockers: string[] = []
  for (const change of plan.webhooks.endpoints) {
    if (change.action === 'ambiguous') {
      const ids = (change.duplicates ?? []).map((id) => printable(id, 40))
      blockers.push(
        `The server has ${ids.length} webhook endpoints with the address ${address(change.url)} ` +
          `(ids ${ids.join(', ')}): tula cannot tell which one the file means and changes none ` +
          'of them. Remove all but one by hand (DELETE /v1/admin/webhook-endpoints/<id>), then ' +
          'run again.'
      )
    }
  }
  if (plan.webhooks.overLimit !== null) {
    blockers.push(
      `The environment would have ${plan.webhooks.overLimit} webhook endpoints and may have ${MAX_WEBHOOK_ENDPOINTS}.`
    )
  }
  return blockers
}

/**
 * What to do about a plan that would leave too many endpoints, said after "Nothing was
 * changed" by `tula apply` and after the blocker by `tula diff`.
 *
 * @example
 * ```ts
 * output.error(`${blocker} Nothing was changed. ${OVER_LIMIT_ADVICE}`)
 * ```
 */
export const OVER_LIMIT_ADVICE =
  'List fewer in the file, or remove the ones it does not list (--prune).'

const MARKER_REASONS: Record<Plan['marker']['reason'], string> = {
  unmanaged: 'the server does not record a config file as the source of these settings yet',
  'other-tool': 'another tool is on record as managing these settings',
  'other-config': 'another version of the config file was applied last',
  drifted: 'the settings were changed outside the config file since the last apply',
  none: '',
}

/**
 * Whether applying a plan makes the server delete audit entries, and from what age: the plan
 * sets an audit retention period where there was none, or a shorter one.
 *
 * @param plan - The plan.
 * @returns The new period in days; `null` when the plan deletes nothing.
 *
 * @example
 * ```ts
 * deletedAuditAge(plan) // 90
 * ```
 */
export function deletedAuditAge(plan: Pick<Plan, 'weakened' | 'body'>): number | null {
  const retentionDays = plan.body.audit?.retentionDays
  return plan.weakened.includes('audit.retentionDays') && typeof retentionDays === 'number'
    ? retentionDays
    : null
}

/**
 * The warnings of a plan, as sentences.
 *
 * @param plan - The plan.
 * @returns One line per warning; empty when there are none.
 *
 * @example
 * ```ts
 * planWarnings(plan) // ['weakens security: mfa.policy']
 * ```
 */
export function planWarnings(plan: Plan): string[] {
  const warnings: string[] = []
  if (plan.weakened.length > 0) {
    warnings.push(
      `weakens security: ${plan.weakened.join(', ')} (\`tula apply --yes\` needs --allow-weaker)`
    )
  }
  // "Weakens security" undersells this one: applying it destroys something. Only "for good"
  // is promised: a run deletes a bounded number of entries, so a backlog takes several.
  const doomed = deletedAuditAge(plan)
  if (doomed !== null) {
    warnings.push(
      `deletes audit entries older than ${doomed} days, for good, starting with the next retention run (every ten minutes; a large backlog takes several)`
    )
  }
  const { created, removed } = webhookCounts(plan)
  if (removed > 0) {
    warnings.push(
      `removes ${removedEndpoints(removed)}, for good (\`tula apply --yes\` needs --allow-webhook-removal)`
    )
  }
  if (created > 0) {
    warnings.push(
      `creates ${created} webhook ${plural(created, 'endpoint: its signing secret is', 'endpoints: each signing secret is')} shown once, to the run that creates it (\`tula apply\` needs --secrets-file <path>, --show-secrets or --discard-secrets)`
    )
  }
  const hooks = hookCounts(plan).created
  if (hooks > 0) {
    warnings.push(
      `creates ${hooks} ${plural(hooks, 'hook: its signing secret is', 'hooks: each signing secret is')} shown once, to the run that creates it (\`tula apply\` needs --secrets-file <path>, --show-secrets or --discard-secrets)`
    )
  }
  for (const change of plan.webhooks.endpoints) {
    if (change.reenables !== undefined) {
      warnings.push(
        `switches on a webhook endpoint the server switched off (${address(change.url)}: ${printable(change.reenables, 60)}); if it still fails the server switches it off again`
      )
    }
  }
  const first = plan.webhooks.removedFirst
  if (first > 0) {
    warnings.push(
      `the environment is at its limit of ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints: ${first} of the removals ${plural(first, 'is', 'are')} made before the new ${plural(created, 'endpoint is', 'endpoints are')} created, to make room`
    )
  }
  if (plan.marker.reason === 'other-tool') {
    warnings.push(MARKER_REASONS['other-tool'])
  }
  // Whatever else is pending: someone saved around the file, and the plan undoes it.
  if (plan.marker.current?.drifted) {
    warnings.push(MARKER_REASONS.drifted)
  }
  if (plan.unknown.length > 0) {
    warnings.push(
      `the server has settings this version of tula does not know (${plan.unknown.join(', ')}); ` +
        'applying resets them to their defaults, so `tula apply` refuses without ' +
        '--allow-unknown. Upgrade tula first.'
    )
  }
  return warnings
}

/**
 * What `tula apply` will not do to a plan without being told to: reset settings this version
 * does not know (`--allow-unknown`); when nobody is asked (`--yes`), weaken security
 * (`--allow-weaker`) or remove a webhook endpoint with its delivery log
 * (`--allow-webhook-removal`); and create a webhook endpoint or a hook without a word on what
 * becomes of its signing secret (`--secrets-file`, `--show-secrets` or `--discard-secrets`).
 *
 * @param plan - The plan.
 * @returns Which of them the plan needs.
 *
 * @example
 * ```ts
 * applyRequirements(plan)
 * // { allowUnknown: false, allowWeaker: true, allowWebhookRemoval: false,
 * //   webhookSecrets: false, hookSecrets: false }
 * ```
 */
export function applyRequirements(plan: Plan): {
  allowUnknown: boolean
  allowWeaker: boolean
  allowWebhookRemoval: boolean
  webhookSecrets: boolean
  hookSecrets: boolean
} {
  const { created, removed } = webhookCounts(plan)
  return {
    allowUnknown: plan.unknown.length > 0,
    allowWeaker: plan.weakened.length > 0,
    allowWebhookRemoval: removed > 0,
    webhookSecrets: created > 0,
    hookSecrets: hookCounts(plan).created > 0,
  }
}

/**
 * What a run says, under `--yes`, to a plan that removes webhook endpoints without
 * `--allow-webhook-removal`, and at a terminal before its question: what is deleted.
 *
 * @param plan - The plan.
 * @returns E.g. `1 webhook endpoint with its pending deliveries and its delivery log`; `null`
 *   when the plan removes none.
 *
 * @example
 * ```ts
 * removedWebhooks(plan) // '2 webhook endpoints with their pending deliveries and their delivery logs'
 * ```
 */
export function removedWebhooks(plan: Pick<Plan, 'webhooks'>): string | null {
  const { removed } = webhookCounts(plan)
  return removed > 0 ? removedEndpoints(removed) : null
}

/**
 * One line that says what a write does.
 *
 * @param operation - The write.
 * @returns E.g. `settings: replace`, `provider google: create`, `webhook https://…: remove`,
 *   `hook before_sign_up: update`.
 *
 * @example
 * ```ts
 * describeOperation({ kind: 'settings' }) // 'settings: replace'
 * ```
 */
export function describeOperation(operation: Operation): string {
  if (operation.kind === 'settings') {
    return 'settings: replace'
  }
  if (
    operation.kind === 'hook.create' ||
    operation.kind === 'hook.update' ||
    operation.kind === 'hook.delete'
  ) {
    const did = { 'hook.create': 'create', 'hook.update': 'update', 'hook.delete': 'remove' }
    return `hook ${operation.point}: ${did[operation.kind]}`
  }
  if (operation.kind === 'provider.delete') {
    return `provider ${operation.provider}: delete`
  }
  if (operation.kind === 'provider.set') {
    return `provider ${operation.provider}: ${operation.change.action}`
  }
  const action = {
    'webhook.create': 'create',
    'webhook.update': 'update',
    'webhook.delete': 'remove',
  }
  return `webhook ${address(operation.url)}: ${action[operation.kind]}`
}

/**
 * Print a plan for a person: what would be added, changed and removed, by path, with warnings.
 * A provider's secret shows as "set from $NAME" or "kept", never as a value.
 *
 * @param output - Where to write.
 * @param target - The environment's name in the config and the API's URL.
 * @param plan - The plan.
 *
 * @example
 * ```ts
 * renderPlan(output, { environment: 'prod', apiUrl }, plan)
 * ```
 */
export function renderPlan(
  output: Output,
  target: { environment: string; apiUrl: string },
  plan: Plan
): void {
  const { style } = output
  output.line(
    style.bold(`Environment "${target.environment}" at ${target.apiUrl}`) +
      style.dim(` (settings revision ${plan.revision})`)
  )
  output.line()
  output.line(style.bold('Settings'))
  if (plan.settings.length === 0) {
    output.line(style.dim('  no changes'))
  }
  for (const change of plan.settings) {
    output.line(settingLine(output, change))
  }
  if (plan.marker.pending) {
    output.line(style.yellow(`  ~ managed-by record: ${MARKER_REASONS[plan.marker.reason]}`))
  }
  if (plan.kept.length > 0) {
    output.line(style.dim(`  kept as on the server (not in the file): ${plan.kept.join(', ')}`))
  }
  if (plan.providers.length > 0) {
    output.line()
    output.line(style.bold('Providers'))
    for (const change of plan.providers) {
      output.line(providerLine(output, change))
    }
  }
  if (plan.webhooks.managed) {
    output.line()
    output.line(style.bold('Webhooks'))
    if (plan.webhooks.endpoints.length === 0) {
      output.line(style.dim('  none in the file, none on the server'))
    }
    for (const change of plan.webhooks.endpoints) {
      output.line(webhookLine(output, change))
    }
    const actions = new Set(plan.webhooks.endpoints.map((endpoint) => endpoint.action))
    // The file cannot say "this address moved": it shows as one endpoint appearing and
    // another the file no longer lists. Said in words, where both are on screen.
    if (actions.has('create') && (actions.has('delete') || actions.has('unmanaged'))) {
      output.line(
        style.dim(
          '  an endpoint is its address: a changed address is a new endpoint with a new signing secret; the old one stays until it is removed (--prune), and its pending deliveries and its delivery log go with it'
        )
      )
    }
  }
  if (plan.hooks.managed) {
    output.line()
    output.line(style.bold('Hooks'))
    if (plan.hooks.hooks.length === 0) {
      output.line(style.dim('  none in the file, none on the server'))
    }
    for (const change of plan.hooks.hooks) {
      output.line(hookLine(output, change))
    }
  }
  const warnings = planWarnings(plan)
  if (warnings.length > 0) {
    output.line()
    for (const warning of warnings) {
      output.line(style.yellow(`  ! ${warning}`))
    }
  }
  output.line()
}

/**
 * A plan for a machine: the same content as {@link renderPlan}, as plain data. A provider's
 * secret appears as `set` or `keep` and the name of its variable, never as a value; a webhook
 * endpoint's and a hook's secret do not appear at all (no read returns one).
 *
 * @param target - The environment's name in the config and the API's URL.
 * @param plan - The plan.
 * @returns A JSON-serialisable object.
 *
 * @example
 * ```ts
 * output.line(JSON.stringify(planToJson({ environment: 'prod', apiUrl }, plan), null, 2))
 * ```
 */
export function planToJson(
  target: { environment: string; apiUrl: string },
  plan: Plan
): Record<string, unknown> {
  return {
    environment: target.environment,
    apiUrl: target.apiUrl,
    revision: plan.revision,
    changes: plan.changes,
    settings: plan.settings,
    weakened: plan.weakened,
    kept: plan.kept,
    unknown: plan.unknown,
    providers: plan.providers,
    webhooks: {
      managed: plan.webhooks.managed,
      endpoints: plan.webhooks.endpoints,
      removedFirst: plan.webhooks.removedFirst,
      overLimit: plan.webhooks.overLimit,
    },
    hooks: { managed: plan.hooks.managed, hooks: plan.hooks.hooks },
    blockers: planBlockers(plan),
    managedBy: {
      supported: plan.marker.supported,
      pending: plan.marker.pending,
      reason: plan.marker.reason,
      current: plan.marker.current,
      configHash: plan.marker.configHash,
    },
    warnings: planWarnings(plan),
    applyRequires: applyRequirements(plan),
  }
}
