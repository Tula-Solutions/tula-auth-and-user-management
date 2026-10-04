import type { Change, Operation, Plan, ProviderChange } from './diff'
import type { Output } from './output'

/** Longest a value is shown before it is cut: a plan is read by a person. */
const MAX_VALUE_LENGTH = 100

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined'
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text
}

function settingLine(output: Output, change: Change): string {
  const { style } = output
  if (change.kind === 'added') {
    return style.green(`  + ${change.path}: ${show(change.after)}`)
  }
  if (change.kind === 'removed') {
    return style.red(`  - ${change.path}: ${show(change.before)}`)
  }
  if (change.added || change.removed) {
    const entries = [
      ...(change.added ?? []).map((entry) => `+${show(entry)}`),
      ...(change.removed ?? []).map((entry) => `-${show(entry)}`),
    ]
    return style.yellow(`  ~ ${change.path}: ${entries.join(' ')}`)
  }
  return style.yellow(`  ~ ${change.path}: ${show(change.before)} → ${show(change.after)}`)
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

const MARKER_REASONS: Record<Plan['marker']['reason'], string> = {
  unmanaged: 'the server does not record a config file as the source of these settings yet',
  'other-tool': 'another tool is on record as managing these settings',
  'other-config': 'another version of the config file was applied last',
  drifted: 'the settings were changed outside the config file since the last apply',
  none: '',
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
 * does not know (`--allow-unknown`), and, when nobody is asked (`--yes`), weaken security
 * (`--allow-weaker`).
 *
 * @param plan - The plan.
 * @returns Which of the two flags the plan needs.
 *
 * @example
 * ```ts
 * applyRequirements(plan) // { allowUnknown: false, allowWeaker: true }
 * ```
 */
export function applyRequirements(plan: Plan): { allowUnknown: boolean; allowWeaker: boolean } {
  return { allowUnknown: plan.unknown.length > 0, allowWeaker: plan.weakened.length > 0 }
}

/**
 * One line that says what a write does.
 *
 * @param operation - The write.
 * @returns E.g. `settings: replace`, `provider google: create`.
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
  return operation.kind === 'provider.delete'
    ? `provider ${operation.provider}: delete`
    : `provider ${operation.provider}: ${operation.change.action}`
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
 * secret appears as `set` or `keep` and the name of its variable, never as a value.
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
