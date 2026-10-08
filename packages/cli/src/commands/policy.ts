import {
  evaluatePassword,
  type PasswordCheck,
  type PasswordUserInfo,
} from '@tula/contract/password-rules'
import { UsageError } from '../args'
import { type Command, type CommandContext, EXIT } from '../framework'
import { resolveTarget } from '../target'

const USAGE = 'tula policy test [--env <name>] [--email <address>] [--name <full name>] [--json]'

/** What each rule asks for, in words. */
function describeRule(check: PasswordCheck): string {
  const params = check.params ?? {}
  switch (check.rule) {
    case 'min_length':
      return `at least ${String(params.min)} characters`
    case 'max_length':
      return `at most ${String(params.max)} characters`
    case 'lowercase':
      return 'a lowercase letter'
    case 'uppercase':
      return 'an uppercase letter'
    case 'number':
      return 'a digit'
    case 'special':
      return 'a special character'
    case 'character_classes':
      return `at least ${String(params.min)} of: lowercase, uppercase, digit, special character`
    case 'user_info':
      return 'does not contain the user’s name or email'
    case 'common':
      return 'not a commonly used password'
    case 'repeated_characters':
      return `no character more than ${String(params.max)} times in a row`
    case 'sequence':
      return 'no run of consecutive characters (abcd, 4321)'
    default:
      return check.code
  }
}

/**
 * The password to test, from the least exposed source available: an argument (accepted for
 * parity with the documented form, with a warning), a prompt that does not echo, or standard
 * input.
 */
async function readPassword(context: CommandContext): Promise<string> {
  const { io, output, positionals } = context
  const argument = positionals[1]
  if (argument !== undefined) {
    output.redact(argument, 'errors')
    output.error(
      `${output.errorStyle.yellow('warning:')} a password on the command line is recorded in shell history and visible in process lists. Leave it out to be asked for it, or pipe it in.`
    )
    return argument
  }
  if (io.stdinIsTTY) {
    if (!io.promptSecret) {
      throw new UsageError(
        'The password cannot be asked for without showing it here. Pipe it in on standard input: `printf %s "$PW" | tula policy test`.'
      )
    }
    return io.promptSecret('Password to test (not shown): ')
  }
  if (!io.readStdin) {
    throw new UsageError('The password cannot be read from standard input here.')
  }
  // One trailing line break is the pipe's, not the password's.
  return (await io.readStdin()).replace(/\r?\n$/, '')
}

/**
 * `tula policy test`: show which rules of an environment's password policy a password passes.
 *
 * The policy is read from the API with the environment's secret key; the rules are evaluated
 * on this machine with the same code the server and the SDKs use (`@tula/contract`). The
 * password is never sent anywhere, printed or logged. The breached-password check is the one
 * rule that is not run: the server makes it when a password is set.
 *
 * @example
 * ```sh
 * tula policy test                       # asks for the password without showing it
 * printf %s "$PW" | tula policy test --email maya@example.com
 * ```
 */
export const policyCommand: Command = {
  name: 'policy',
  summary: 'Test a password against an environment’s password policy.',
  usage: USAGE,
  description:
    'Shows which rules of the environment’s password policy a password passes. The password ' +
    'is asked for without being shown, or read from standard input when it is piped. It is ' +
    'checked on this machine and never sent anywhere; the breached-password check, which only ' +
    'the server makes, is reported as not run. A password given as an argument works too, with ' +
    'a warning: a command line is recorded in shell history.\n\n' +
    'The secret key decides the environment (TULA_SECRET_KEY, or TULA_SECRET_KEY_<NAME> with ' +
    '--env <name>).\n\n' +
    'Exit codes: 0 the password would be accepted, 2 it would be refused, 1 an error.',
  maxPositionals: 2,
  options: {
    env: {
      type: 'string',
      short: 'e',
      value: '<name>',
      description: 'Read TULA_SECRET_KEY_<NAME> and TULA_API_URL_<NAME> first.',
    },
    'api-url': {
      type: 'string',
      value: '<url>',
      description: 'The Tula API. Default: TULA_API_URL_<NAME>, then TULA_API_URL.',
    },
    'insecure-http': {
      type: 'boolean',
      description: 'Allow a plain http API URL that is not localhost.',
    },
    'secret-key-file': {
      type: 'string',
      value: '<path>',
      description:
        'Read the secret key from a file. Default: TULA_SECRET_KEY_<NAME>, then TULA_SECRET_KEY.',
    },
    email: {
      type: 'string',
      value: '<address>',
      description: 'The user’s email, for the "does not contain your name or email" rule.',
    },
    name: {
      type: 'string',
      value: '<full name>',
      description: 'The user’s name, for the same rule.',
    },
    json: { type: 'boolean', description: 'Print the result as JSON.' },
  },
  run: async (context) => {
    const { flags, io, output, positionals } = context
    if (positionals[0] !== 'test') {
      throw new UsageError(`Usage: ${USAGE}`)
    }
    if (flags['secret-key-file'] === '-') {
      throw new UsageError(
        '--secret-key-file - would read the key from standard input, which is where the password comes from. Use a file or TULA_SECRET_KEY.'
      )
    }
    const name = typeof flags.env === 'string' ? flags.env : 'default'
    // Before the password is read: a missing key should not cost a typed password.
    const target = await resolveTarget({ name, environment: {}, flags, io, output })
    const password = await readPassword(context)
    // On standard error only: the results below are fixed text, and a password that is an
    // ordinary word (`password`) must not garble them.
    output.redact(password, 'errors')
    if (password === '') {
      throw new UsageError('No password was given.')
    }

    const { data } = await target.admin.call('getEnvironmentSettings')
    const policy = data.settings.password
    if (!policy) {
      throw new UsageError('The API did not answer with a password policy.')
    }
    const [firstName, ...rest] =
      typeof flags.name === 'string' ? flags.name.trim().split(/\s+/) : []
    const userInfo: PasswordUserInfo = {
      email: typeof flags.email === 'string' ? flags.email : undefined,
      firstName,
      lastName: rest.length > 0 ? rest.join(' ') : undefined,
    }
    const hasUserInfo = userInfo.email !== undefined || firstName !== undefined
    const evaluation = evaluatePassword(policy, password, userInfo)
    const failed = evaluation.checks.filter((check) => !check.passed)
    const breach = { policy: policy.breachCheck, ran: false }

    if (flags.json) {
      output.line(
        JSON.stringify(
          {
            apiUrl: target.apiUrl,
            preset: policy.preset,
            accepted: evaluation.ok,
            rules: evaluation.checks.map((check) => ({
              rule: check.rule,
              code: check.code,
              passed: check.passed,
              description: describeRule(check),
            })),
            breachCheck: breach,
            userInfoGiven: hasUserInfo,
          },
          null,
          2
        )
      )
      return evaluation.ok ? EXIT.ok : EXIT.refused
    }

    const { style } = output
    output.line(style.bold(`Password policy at ${target.apiUrl} (preset: ${policy.preset})`))
    output.line()
    const width = Math.max(...evaluation.checks.map((check) => check.rule.length), 'breach'.length)
    for (const check of evaluation.checks) {
      const label = check.passed ? style.green('pass   ') : style.red('FAIL   ')
      const note =
        check.rule === 'user_info' && !hasUserInfo
          ? ' (nothing to compare with: pass --email or --name)'
          : ''
      output.line(`  ${label}  ${check.rule.padEnd(width)}  ${describeRule(check)}${note}`)
    }
    output.line(
      `  ${style.dim('not run')}  ${'breach'.padEnd(width)}  ${
        policy.breachCheck === 'off'
          ? 'the breached-password check is off in this environment'
          : `the breached-password check (policy: ${policy.breachCheck}) is made by the server when a password is set, not here`
      }`
    )
    output.line()
    output.line(
      evaluation.ok
        ? 'This password would be accepted by the rules above.'
        : `This password would be refused: it breaks ${failed.length} rule${failed.length === 1 ? '' : 's'}.`
    )
    output.line('It was checked on this machine and was not sent anywhere.')
    return evaluation.ok ? EXIT.ok : EXIT.refused
  },
}
