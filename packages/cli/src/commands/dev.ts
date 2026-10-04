import { UsageError } from '../args'
import { startDev, stopDev } from '../dev'
import { type Command, EXIT } from '../framework'

const USAGE =
  'tula dev [--project-name <name>] [--show-keys] [--rotate-keys] [--timeout <seconds>]\n' +
  '       tula dev down [--volumes [--yes]] [--project-name <name>]'

/** How long pulling, building, migrating and becoming ready may each take, by default. */
const DEFAULT_TIMEOUT_SECONDS = 900

/**
 * `tula dev`: start the project's local stack with Docker Compose, migrate, seed, mint
 * development keys into `.env.local` and print the URLs. `tula dev down` stops it.
 *
 * @example
 * ```sh
 * tula dev            # start, or continue: running it again changes nothing
 * tula dev down       # stop; --volumes also deletes the database
 * ```
 */
export const devCommand: Command = {
  name: 'dev',
  summary: 'Start the local stack: Compose, migrations, seed, development keys.',
  usage: USAGE,
  description:
    'Runs in a project made by create-tula (a directory with a Compose file that has `api` ' +
    'and `migrate` services). Starts the services, runs the migrations and the seed with the ' +
    'commands the API image ships, mints a publishable and a secret development key, writes ' +
    'them to its own block of .env.local (your own lines are never changed) and prints the ' +
    'URLs. A second run reuses the keys. The secret key is printed only with --show-keys.\n\n' +
    '`tula dev down` stops the stack and keeps the data; `--volumes` deletes the database ' +
    'after a confirmation (--yes without a terminal).\n\n' +
    'The Compose project name comes from --project-name, else COMPOSE_PROJECT_NAME, else ' +
    'Compose’s default (the directory’s name). Ports come from the Compose file and its .env.\n\n' +
    'Exit codes: 0 done, 1 an error.',
  maxPositionals: 1,
  options: {
    'project-name': {
      type: 'string',
      short: 'p',
      value: '<name>',
      description: 'The Compose project name. Default: COMPOSE_PROJECT_NAME, then the directory.',
    },
    'show-keys': { type: 'boolean', description: 'Print the secret key too.' },
    'rotate-keys': {
      type: 'boolean',
      description: 'Mint new keys and replace the ones tula dev wrote.',
    },
    timeout: {
      type: 'string',
      value: '<seconds>',
      description: `How long one step may take. Default: ${DEFAULT_TIMEOUT_SECONDS}.`,
    },
    volumes: { type: 'boolean', description: 'With `down`: delete the database too.' },
    yes: { type: 'boolean', short: 'y', description: 'With `down --volumes`: do not ask.' },
  },
  run: async ({ flags, positionals, io, output }) => {
    const [subcommand] = positionals
    if (subcommand !== undefined && subcommand !== 'down') {
      throw new UsageError(`Usage: ${USAGE}`)
    }
    const { host } = io
    if (!host) {
      throw new UsageError('tula dev cannot run processes here.')
    }
    const projectName =
      typeof flags['project-name'] === 'string' ? flags['project-name'] : undefined
    if (projectName !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(projectName)) {
      throw new UsageError(
        '--project-name must be lowercase letters, digits, dashes and underscores, starting with a letter or digit.'
      )
    }

    if (subcommand === 'down') {
      const volumes = flags.volumes === true
      if (volumes && flags.yes !== true) {
        if (!io.isTTY || !io.prompt) {
          throw new UsageError(
            '`tula dev down --volumes` deletes the database. Pass --yes to do that without a terminal to confirm on.'
          )
        }
        const answer = await io.prompt(
          'Delete this project’s database and every user in it? [y/N] '
        )
        if (!/^y(es)?$/i.test(answer.trim())) {
          output.error('Nothing was stopped or deleted.')
          return EXIT.error
        }
      }
      await stopDev({ io, output, host, projectName, volumes })
      return EXIT.ok
    }
    if (flags.volumes === true || flags.yes === true) {
      throw new UsageError('--volumes and --yes belong to `tula dev down`.')
    }
    const seconds = flags.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(flags.timeout)
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7_200) {
      throw new UsageError('--timeout is a number of seconds, from 1 to 7200.')
    }
    await startDev({
      io,
      output,
      host,
      projectName,
      timeoutMs: seconds * 1000,
      showKeys: flags['show-keys'] === true,
      rotateKeys: flags['rotate-keys'] === true,
    })
    return EXIT.ok
  },
}
