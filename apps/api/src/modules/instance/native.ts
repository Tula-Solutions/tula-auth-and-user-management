import { isDeepStrictEqual } from 'node:util'
import {
  AppleAppSiteAssociationSchema,
  ASSET_LINKS_RELATIONS,
  AssetLinksSchema,
  type EnvironmentSettings,
  isRelyingPartyId,
  MAX_NATIVE_APPS,
  NATIVE_APP_PLATFORMS,
  type NativeAppPlatform,
} from '@tula/contract'
import type { Deps } from '~/dependencies'
import { isLoopbackHost } from '~/env'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import * as NativeApps from '~/modules/native-app/service'
import type { FetchedDocument } from '~/ports/diagnostics'
import type { NativeAppRecord } from '~/ports/native-app-store'
import { attempt, plural } from './helpers'
import type { DiagnosticCheck } from './schema'

/**
 * The most association files one run fetches over HTTP: one per platform, each of the oldest
 * environment that has an app of that platform. A sample, and the check's text says so: the
 * route is the same code for every environment, so one answer per file shows whether the
 * address serves it.
 */
export const NATIVE_APP_FILES_FETCHED = NATIVE_APP_PLATFORMS.length

/** The name each platform's file has under an environment's `.well-known` path. */
const FILE_OF: Record<NativeAppPlatform, string> = {
  ios: 'apple-app-site-association',
  android: 'assetlinks.json',
}

/** A file to fetch, with what the server built for it. Never leaves the service. */
interface Sample {
  platform: NativeAppPlatform
  environmentId: string
  built: unknown
}

/**
 * What the scan found about native apps, as counts. The samples are for the fetch that
 * follows and are never part of an answer.
 */
export interface NativeFindings {
  /** Environments, of those checked, with at least one app. */
  environments: number
  /** Their apps. */
  apps: number
  /** Apps this version would not register as they are stored. */
  malformed: number
  /** Environments with more apps than one may have. */
  overCap: number
  /** Environments whose built files do not name exactly their stored apps. */
  mismatched: number
  /**
   * Of the environments with apps: those with passkeys off, and those with passkeys on and a
   * relying party no platform can associate with an app. `null` when the settings could not
   * be read.
   */
  passkeys: { off: number; unassociable: number } | null
  samples: Sample[]
}

/**
 * The findings of a scan that has looked at nothing yet.
 *
 * @returns Every count at zero.
 */
export function noFindings(): NativeFindings {
  return {
    environments: 0,
    apps: 0,
    malformed: 0,
    overCap: 0,
    mismatched: 0,
    passkeys: { off: 0, unassociable: 0 },
    samples: [],
  }
}

/**
 * Whether the two files name exactly the stored apps: every iOS row as `<team>.<bundle id>`,
 * every Android row with its fingerprints and the relations the server serves, and nothing
 * else. The expectation is worked out here from the rows, apart from the code that builds
 * the files, and each file must also pass the schema the public route answers with (a file
 * that does not is a 500 there).
 */
function namesExactly(
  records: readonly NativeAppRecord[],
  files: ReturnType<typeof NativeApps.associationFiles>
): boolean {
  const apple = AppleAppSiteAssociationSchema.safeParse(files.apple)
  const android = AssetLinksSchema.safeParse(files.android)
  if (!apple.success || !android.success) {
    return false
  }
  const ios = records
    .filter((record) => record.platform === 'ios')
    .map((record) => `${record.teamId}.${record.identifier}`)
    .sort()
  const expected = records
    .filter((record) => record.platform === 'android')
    .map((record) => ({
      name: record.identifier,
      relation: [...ASSET_LINKS_RELATIONS],
      fingerprints: [...record.sha256CertFingerprints].sort(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  const named = android.data
    .map((statement) => ({
      name: statement.target.package_name,
      relation: statement.relation,
      fingerprints: [...statement.target.sha256_cert_fingerprints].sort(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  return (
    records.every((record) => NATIVE_APP_PLATFORMS.includes(record.platform)) &&
    isDeepStrictEqual([...(apple.data.webcredentials?.apps ?? [])].sort(), ios) &&
    isDeepStrictEqual(named, expected)
  )
}

/** Count one environment's apps into the findings. Ids go to the log; nothing else does. */
function count(findings: NativeFindings, environmentId: string, records: NativeAppRecord[]) {
  findings.environments += 1
  findings.apps += records.length
  const malformed = records.filter((record) => !NativeApps.wellFormed(record))
  if (malformed.length > 0) {
    findings.malformed += malformed.length
    // The answer holds a count. The log names the rows by the ids the server made, so that
    // an operator can find them: never an identifier, a team or a fingerprint.
    logger.warn('native app is not well formed', {
      check: 'native_app_identities',
      environmentId,
      apps: malformed.slice(0, MAX_NATIVE_APPS).map((record) => record.id),
    })
  }
  findings.overCap += records.length > MAX_NATIVE_APPS ? 1 : 0
  const files = NativeApps.associationFiles(records)
  if (!namesExactly(records, files)) {
    findings.mismatched += 1
    logger.warn('the association files do not name exactly the stored apps', {
      check: 'native_app_files',
      environmentId,
    })
    return
  }
  for (const platform of NATIVE_APP_PLATFORMS) {
    const sampled = findings.samples.some((sample) => sample.platform === platform)
    if (!sampled && records.some((record) => record.platform === platform)) {
      const built = platform === 'ios' ? files.apple : files.android
      findings.samples.push({ platform, environmentId, built })
    }
  }
}

/**
 * Whether a platform can associate an app with a relying party: a domain name, and not this
 * machine's. The association file is fetched from `https://<rpId>/.well-known/…` by Apple's
 * and Google's servers, which reach neither `localhost` nor a `.localhost` name; an IP
 * address is no relying-party id at all (the contract's `isRelyingPartyId`).
 */
function associable(rpId: string | null): boolean {
  return rpId !== null && isRelyingPartyId(rpId) && !isLoopbackHost(rpId)
}

/**
 * Read one environment's native apps into the findings: what the three native checks are
 * about (ADR 0040, "What `tula doctor` checks").
 *
 * One store call, and for an environment that has an app one read of its settings (three
 * fields are looked at and two counts come back: no setting leaves this function). A store
 * that fails is logged and the findings become `null` (the three checks then say they could
 * not look); settings that fail cost only the passkey check. The rest of the scan goes on.
 *
 * @param deps - The app store.
 * @param environmentId - The environment.
 * @param findings - The findings so far; counted into.
 * @param settings - The environment's settings, read when asked and at most once.
 * @returns The findings, or `null` when the apps could not be read.
 */
export async function read(
  deps: Pick<Deps, 'nativeApps'>,
  environmentId: string,
  findings: NativeFindings,
  settings: () => Promise<Pick<EnvironmentSettings, 'signIn' | 'passkeys'>>
): Promise<NativeFindings | null> {
  let records: NativeAppRecord[]
  try {
    records = await deps.nativeApps.list(environmentId)
  } catch (error) {
    logger.warn('diagnostic check failed', { check: 'native_apps', reason: errorReason(error) })
    return null
  }
  if (records.length === 0) {
    return findings
  }
  count(findings, environmentId, records)
  if (findings.passkeys !== null) {
    try {
      const { signIn, passkeys } = await settings()
      if (!signIn.methods.passkey.enabled) {
        findings.passkeys.off += 1
      } else if (!associable(passkeys.rpId)) {
        findings.passkeys.unassociable += 1
      }
    } catch (error) {
      logger.warn('diagnostic check failed', {
        check: 'native_app_passkeys',
        reason: errorReason(error),
      })
      findings.passkeys = null
    }
  }
  return findings
}

/** How the fetch of one association file went. A fixed word, and for a status its number. */
export type Fetched =
  | { kind: 'served' | 'unanswered' | 'redirect' | 'not_json' | 'different' }
  | { kind: 'status'; status: number }

/** Compare an answer with the file the server built. Nothing of the answer is kept. */
function judge(answer: FetchedDocument | null, built: unknown): Fetched {
  if (!answer) {
    return { kind: 'unanswered' }
  }
  if (answer.status >= 300 && answer.status < 400) {
    return { kind: 'redirect' }
  }
  if (answer.status !== 200) {
    return { kind: 'status', status: answer.status }
  }
  if (!/^application\/json\s*(?:;|$)/i.test(answer.contentType ?? '') || answer.body === null) {
    return { kind: 'not_json' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(answer.body)
  } catch {
    return { kind: 'not_json' }
  }
  return { kind: isDeepStrictEqual(parsed, built) ? 'served' : 'different' }
}

/**
 * Fetch the sampled association files at the deployment's own `PUBLIC_URL` and compare each
 * with what the server built.
 *
 * **The only origin requested is `PUBLIC_URL`**, and the path is the server's own route with
 * an environment id the server made: never an operator's domain (that address is theirs, and
 * the outbound guard is for webhooks and hooks), never a relying-party id, never anything a
 * request or a setting said. At most {@link NATIVE_APP_FILES_FETCHED} requests, side by side,
 * each cut off after `timeoutMs`.
 *
 * @param deps - The configuration and the probes.
 * @param findings - What the scan found; `null` when it found nothing out.
 * @param timeoutMs - How long each request may take.
 * @returns One outcome per file fetched; empty when there was nothing to fetch.
 */
export async function fetchFiles(
  deps: Pick<Deps, 'config' | 'diagnostics'>,
  findings: NativeFindings | null,
  timeoutMs: number
): Promise<Fetched[]> {
  const base = deps.config.publicUrl.replace(/\/+$/, '')
  const samples = findings?.samples.slice(0, NATIVE_APP_FILES_FETCHED) ?? []
  return Promise.all(
    samples.map(async (sample) => {
      const url = `${base}/v1/environments/${encodeURIComponent(sample.environmentId)}/.well-known/${FILE_OF[sample.platform]}`
      const answer = await attempt(
        'native_app_files',
        () => deps.diagnostics.httpDocument(url, timeoutMs),
        timeoutMs
      )
      const fetched = judge(answer?.value ?? null, sample.built)
      if (fetched.kind !== 'served') {
        logger.warn('an association file is not served as built', {
          check: 'native_app_files',
          environmentId: sample.environmentId,
          platform: sample.platform,
          outcome: fetched.kind,
        })
      }
      return fetched
    })
  )
}

/** What a native check is given: the scan's counts, or `null` when the scan failed. */
type Scanned = {
  value: { environments: number; checked: number; native: NativeFindings | null }
} | null

const HOW =
  'Native apps are managed on the dashboard’s native apps screen, through `/v1/admin/native-apps`, or as `nativeApps` in `tula.config.ts` with `tula apply` (docs/native-apps.md).'

const NOT_THE_PLATFORMS =
  'Whether Apple or Android can reach them at the apps’ own domain was not checked: the server never requests that address.'

/** The part of the deployment a truncated scan looked at, or `null` when it read all of it. */
function partial(stored: NonNullable<Scanned>): { scope: string; rest: string } | null {
  const { environments, checked } = stored.value
  if (checked >= environments) {
    return null
  }
  const rest = environments - checked
  return {
    scope: `the first ${checked} of ${environments} environments`,
    rest: `The other ${rest} ${rest === 1 ? 'was' : 'were'} not read.`,
  }
}

/** `in 2 environments`, and of which when the scan did not read them all. */
function where(stored: NonNullable<Scanned>, count: number): string {
  const part = partial(stored)
  return `in ${plural(count, 'environment')}${part ? ` of ${part.scope}` : ''}`
}

/** What a native check works on once there is something to check. */
interface Subject {
  stored: NonNullable<Scanned>
  native: NativeFindings
}

/**
 * What every native check says before it looks at its own counts: the apps could not be
 * read, or there are none. Otherwise the counts to look at.
 */
function subjectOf(id: string, stored: Scanned): DiagnosticCheck | Subject {
  const native = stored?.value.native ?? null
  if (!stored || native === null) {
    return {
      id,
      status: 'skipped',
      summary: 'Not checked: the native apps could not be read from the database.',
    }
  }
  if (native.apps > 0) {
    return { stored, native }
  }
  const part = partial(stored)
  if (!part) {
    return { id, status: 'skipped', summary: 'No native app is registered in any environment.' }
  }
  return {
    id,
    status: 'warn',
    summary: `Only ${part.scope} were looked at: none of them has a native app. ${part.rest}`,
    fix: `One run reads the native apps of the ${stored.value.checked} oldest environments only. A newer environment’s apps were not checked.`,
  }
}

/** A finding of "nothing wrong": `ok`, or a warning when the scan did not read everything. */
function nothingWrong(id: string, stored: NonNullable<Scanned>, summary: string): DiagnosticCheck {
  const part = partial(stored)
  if (!part) {
    return { id, status: 'ok', summary }
  }
  return {
    id,
    status: 'warn',
    summary: `Only ${part.scope} were looked at. ${summary} ${part.rest}`,
    fix: `One run reads the native apps of the ${stored.value.checked} oldest environments only. A newer environment’s apps were not checked.`,
  }
}

/**
 * Whether every registered native app is one this version would register (ADR 0040, "What
 * `tula doctor` checks").
 *
 * A registration is validated and the table has its own checks, so what can still be wrong
 * is a row written by another version or by hand: `fail`, because the association files name
 * an app as it is stored and a platform refuses what it is then told. An environment over
 * the cap is a warning: its files are served and only a further registration is refused.
 *
 * It cannot say that an identifier is the **right** one: the server has never seen the app.
 * Counts only: never an identifier, a team, a fingerprint or an environment's id.
 *
 * @param scanned - What the scan found; `null` when the scan failed.
 * @returns The check.
 */
export function identitiesCheck(scanned: Scanned): DiagnosticCheck {
  const id = 'native_app_identities'
  const subject = subjectOf(id, scanned)
  if ('status' in subject) {
    return subject
  }
  const { stored } = subject
  const { apps, environments, malformed, overCap } = subject.native
  if (malformed > 0) {
    return {
      id,
      status: 'fail',
      summary: `${malformed} of the ${plural(apps, 'native app')} registered ${where(stored, environments)} ${malformed === 1 ? 'is' : 'are'} not well formed: a bundle ID, a package name, a team ID or a certificate fingerprint this version refuses, or an Android app with no fingerprint.`,
      fix: `Remove each such app and register it again with the right values. The API’s log names each one by its id, under \`native app is not well formed\`. ${HOW}`,
    }
  }
  if (overCap > 0) {
    return {
      id,
      status: 'warn',
      summary: `More than ${MAX_NATIVE_APPS} native apps, the most an environment may have, are registered ${where(stored, overCap)}: a further registration there is refused.`,
      fix: `Remove the apps that are no longer shipped. ${HOW}`,
    }
  }
  return nothingWrong(
    id,
    stored,
    `The ${plural(apps, 'native app')} registered ${where(stored, environments)} ${apps === 1 ? 'is' : 'are'} well formed: each passes the rules a registration is held to. Whether a bundle ID, a team or a fingerprint is the one your app really has cannot be checked from here.`
  )
}

/**
 * Whether the association files are built from exactly the registered apps and served at
 * the deployment's own address (ADR 0040, "What `tula doctor` checks").
 *
 * Two halves, and the text says which was looked at. In process, for every environment
 * checked: the files the public route's own function builds name exactly the stored apps.
 * Over HTTP, for a sample of at most {@link NATIVE_APP_FILES_FETCHED}: the route answers at
 * `PUBLIC_URL` with HTTP 200, `application/json`, no redirect and the body that was built.
 *
 * A file that is built wrong, redirected, answered with another status or not as JSON is a
 * `fail`: a platform is given the same answer through the operator's domain and takes none
 * of them. A body that differs is a `warn`: the route lets a cache keep a copy for five
 * minutes, so a difference just after a change is expected. No answer at all is a `warn`
 * too: nothing was seen to be wrong, and `public_url` says why the address does not answer.
 *
 * **`ok` is about the server's own copies.** Whether Apple or Android reach them at the
 * apps' domain is the operator's proxy, which the server never requests. Counts and a
 * status code only.
 *
 * @param scanned - What the scan found; `null` when the scan failed.
 * @param loopback - Whether `PUBLIC_URL` is a loopback address, which is not fetched.
 * @param fetched - How each sampled fetch went.
 * @returns The check.
 */
export function filesCheck(
  scanned: Scanned,
  loopback: boolean,
  fetched: readonly Fetched[]
): DiagnosticCheck {
  const id = 'native_app_files'
  const subject = subjectOf(id, scanned)
  if ('status' in subject) {
    return subject
  }
  const { stored } = subject
  const { environments, mismatched } = subject.native
  if (mismatched > 0) {
    return {
      id,
      status: 'fail',
      summary: `The association files the server builds do not name exactly the registered native apps, ${where(stored, mismatched)}.`,
      fix: 'A stored app that is not well formed does this (see `native_app_identities`): remove it and register it again. If every app is well formed this is a fault in the server: report it with the API’s version. The API’s log names the environments, under `the association files do not name exactly the stored apps`.',
    }
  }
  const built = `The association files the server builds name exactly the registered native apps (${where(stored, environments)}).`
  if (loopback) {
    return nothingWrong(
      id,
      stored,
      `${built} They were not fetched: PUBLIC_URL is a loopback address, which the server cannot check from where it runs. ${NOT_THE_PLATFORMS}`
    )
  }
  const address =
    'Check the proxy in front of the API: it must pass `/v1/environments/<id>/.well-known/apple-app-site-association` and `…/assetlinks.json` on to the API unchanged, with no redirect, and your own domain must answer `/.well-known/…` with what those paths return (docs/native-apps.md).'
  const found = (kind: Fetched['kind']) => fetched.find((one) => one.kind === kind)
  if (found('redirect')) {
    return {
      id,
      status: 'fail',
      summary: `${built} But fetched at PUBLIC_URL, a file is answered with a redirect: Apple and Android follow none.`,
      fix: address,
    }
  }
  const refused = found('status')
  if (refused?.kind === 'status') {
    return {
      id,
      status: 'fail',
      summary: `${built} But fetched at PUBLIC_URL, a file is answered with HTTP ${refused.status} instead of the file.`,
      fix: address,
    }
  }
  if (found('not_json')) {
    return {
      id,
      status: 'fail',
      summary: `${built} But fetched at PUBLIC_URL, a file does not come back as JSON (\`application/json\`), which both platforms require.`,
      fix: address,
    }
  }
  if (found('different')) {
    return {
      id,
      status: 'warn',
      summary: `${built} But fetched at PUBLIC_URL, a file comes back different from what the server builds now.`,
      fix: 'A cache in front of the API may keep a copy for five minutes after an app was changed (`Cache-Control: max-age=300`): run the check again later. If the file stays different, something in front of the API changes the answer: have it pass the file on unchanged.',
    }
  }
  if (found('unanswered')) {
    return {
      id,
      status: 'warn',
      summary: `${built} But a file could not be fetched at PUBLIC_URL: there was no answer in time.`,
      fix: 'See the `public_url` check: the server could not reach its own address, so whether the files are served there was not seen.',
    }
  }
  return nothingWrong(
    id,
    stored,
    `${built} ${fetched.length === 1 ? 'One of them' : `${fetched.length} of them`}, fetched at PUBLIC_URL, came back as built: HTTP 200, \`application/json\`, no redirect. These are the server’s own copies. ${NOT_THE_PLATFORMS}`
  )
}

/**
 * Whether the passkey relying party of an environment with native apps is one a platform can
 * associate an app with (ADR 0040, "What `tula doctor` checks"; ADR 0027).
 *
 * An app uses the passkeys of a domain only when that domain serves the association file
 * that names it, at `https://<rpId>/.well-known/…`. So where apps are registered, the relying
 * party must be a domain name and not `localhost` or a loopback name (an IP address is no
 * relying-party id at all). Passkeys off, or a relying party that cannot be associated, is a
 * `warn` and never a `fail`: nothing that worked is broken, the apps only cannot use
 * passkeys there.
 *
 * **It cannot see whether the domain serves the files**: that is the operator's proxy, and
 * the server never requests an operator's domain. `ok` says so. Counts only: never a
 * relying-party id, a domain or an environment's id.
 *
 * @param scanned - What the scan found; `null` when the scan failed.
 * @returns The check.
 */
export function passkeysCheck(scanned: Scanned): DiagnosticCheck {
  const id = 'native_app_passkeys'
  const subject = subjectOf(id, scanned)
  if ('status' in subject) {
    return subject
  }
  const { stored } = subject
  const { environments, passkeys } = subject.native
  if (passkeys === null) {
    return {
      id,
      status: 'skipped',
      summary: 'Not checked: the environments’ settings could not be read from the database.',
    }
  }
  const proxy =
    'That domain must answer `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` with the environment’s files, by passing the request on to this API (docs/native-apps.md). This check cannot see whether it does: the server never requests your domain.'
  if (passkeys.unassociable > 0) {
    const off =
      passkeys.off > 0
        ? ` In ${passkeys.off} more with native apps, passkeys are switched off.`
        : ''
    return {
      id,
      status: 'warn',
      summary: `Passkeys are on ${where(stored, passkeys.unassociable)} with native apps where the relying party (\`passkeys.rpId\`) is not a domain a platform can associate with an app: it is not set, it is \`localhost\` or a loopback name, or it is no domain name. The apps there cannot use passkeys.${off}`,
      fix: `Set \`passkeys.rpId\` in those environments’ settings to the domain the apps name as their associated domain (changing it orphans the passkeys already registered). ${proxy}`,
    }
  }
  if (passkeys.off > 0) {
    return {
      id,
      status: 'warn',
      summary: `Passkeys are switched off ${where(stored, passkeys.off)} with native apps: the apps there cannot sign in with a passkey.`,
      fix: `If the apps are meant to use passkeys, switch the passkey sign-in method on in those environments’ settings and set \`passkeys.rpId\` to the domain the apps name as their associated domain. ${proxy} An app that only fills in saved passwords needs neither.`,
    }
  }
  return nothingWrong(
    id,
    stored,
    `Passkeys are on ${where(stored, environments)} with native apps, and the relying party there is a domain a platform can associate with an app. Whether that domain serves the association files was not checked: the server never requests it.`
  )
}
