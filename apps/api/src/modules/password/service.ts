import {
  type ErrorCode,
  errorDefinition,
  evaluatePassword,
  type FieldError,
  normalizePassword,
  type PasswordPolicy,
  type PasswordUserInfo,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ServiceException } from '~/exceptions'

/**
 * argon2id parameters for every stored password, pinned so a Bun upgrade can't silently change
 * them. 64 MiB / 2 passes is above OWASP's minimum (19 MiB / 2). Raising them makes existing
 * hashes report {@link needsRehash} so they upgrade on the next sign-in.
 */
export const HASH_OPTIONS = { algorithm: 'argon2id', memoryCost: 65_536, timeCost: 2 } as const

/**
 * Longest password (in code points) the server will hash or verify, whatever the policy says.
 * Matches the contract's ceiling for `maxLength` and stops multi-megabyte inputs being hashed.
 */
export const MAX_PASSWORD_LENGTH = 1024

/**
 * Hash of a random, discarded password, made with {@link HASH_OPTIONS}. Unknown users are
 * verified against it so they cost the same argon2id work as real ones. It is safe to publish:
 * `verify(null, …)` returns false whatever this hash matches.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$6UPSxbALfg+qiYLsSJZVCEirNUMx02RS54WyXH3jMfE$fX52GP8UlKtUYDMHRDIdBmrmEps+/rCKGNM6H2fZQow'

const CURRENT_PREFIX = `$argon2id$v=19$m=${HASH_OPTIONS.memoryCost},t=${HASH_OPTIONS.timeCost},p=1$`

/**
 * Raw UTF-16 length above which input can't normalize to {@link MAX_PASSWORD_LENGTH} code points.
 * NFC merges at most 4 code points into one and a code point is at most 2 UTF-16 units; 16x
 * leaves margin. Checked first so huge inputs are refused before any O(n) normalization.
 */
const MAX_RAW_LENGTH = MAX_PASSWORD_LENGTH * 16

/** @returns The NFC-normalized password, or `null` when it is over the hard cap. */
function normalizeCapped(password: string): string | null {
  if (password.length > MAX_RAW_LENGTH) {
    return null
  }
  const normalized = normalizePassword(password)
  return [...normalized].length > MAX_PASSWORD_LENGTH ? null : normalized
}

/**
 * Hash a password for storage with argon2id.
 *
 * The password is NFC-normalized first so the same passphrase typed on any platform verifies.
 *
 * @param password - The plaintext password (already accepted by {@link assess}).
 * @returns The PHC-format hash.
 * @throws AuthError `password.too_long` above {@link MAX_PASSWORD_LENGTH} code points.
 */
export async function hash(password: string): Promise<string> {
  const normalized = normalizeCapped(password)
  if (normalized === null) {
    throw new AuthError('password.too_long', { max: MAX_PASSWORD_LENGTH })
  }
  return Bun.password.hash(normalized, HASH_OPTIONS)
}

/**
 * Check a password against a stored hash in comparable time whether or not the user exists.
 *
 * Pass `null` when there is no account (or no password credential): a dummy hash with the same
 * parameters is verified instead, so response timing does not reveal which accounts exist.
 *
 * @param storedHash - The user's argon2id hash, or `null` for an unknown user.
 * @param password - The password the client sent.
 * @returns `true` only when a real hash matches.
 */
export async function verify(storedHash: string | null, password: string): Promise<boolean> {
  const normalized = normalizeCapped(password)
  // No stored password can be this long, so rejecting early leaks nothing about the account.
  if (normalized === null) {
    return false
  }
  const matches = await Bun.password.verify(normalized, storedHash ?? DUMMY_HASH)
  return storedHash !== null && matches
}

/**
 * Whether a stored hash was made with weaker or different parameters than {@link HASH_OPTIONS}.
 *
 * Sign-in rehashes such passwords after a successful verify.
 *
 * @param storedHash - A stored password hash.
 * @returns `true` when it should be replaced.
 */
export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith(CURRENT_PREFIX)
}

/**
 * The password policy that applies in an environment.
 *
 * Phase 0 has one policy per deployment (`PASSWORD_POLICY`); per-environment policies arrive with
 * the dashboard, which is why this already takes the tenant.
 *
 * @param deps - App config.
 * @param _tenant - The environment asking.
 * @returns The active policy.
 */
export async function policy(
  deps: Pick<Deps, 'config'>,
  _tenant: Pick<Tenant, 'environmentId'>
): Promise<PasswordPolicy> {
  return deps.config.passwordPolicy
}

/** Result of a password that is allowed to be set. */
export interface PasswordAssessment {
  /** Non-blocking problems, e.g. `password.breached` under a `warn` policy. */
  warnings: FieldError[]
}

function fieldError(code: ErrorCode, params?: FieldError['params']): FieldError {
  return {
    field: 'password',
    code,
    message: errorDefinition(code).message,
    ...(params && { params }),
  }
}

/**
 * Check a new password against the environment's policy and the breached-password source.
 *
 * Used when a password is set (sign-up, reset, change), where detailed errors are wanted; never
 * on sign-in, which must stay generic. The breach lookup runs only after the local rules pass,
 * and fails open when the source is unavailable: blocking every sign-up during a third-party
 * outage is worse than missing one check.
 *
 * @param deps - Config and breach checker.
 * @param tenant - The environment whose policy applies.
 * @param password - The candidate password.
 * @param userInfo - Details the password must not contain.
 * @returns Non-blocking warnings.
 * @throws ServiceException with the first failed rule's code (422) and every failed rule in
 *   `errors`, or `password.breached` when the policy blocks breached passwords.
 */
export async function assess(
  deps: Pick<Deps, 'config' | 'breachChecker'>,
  tenant: Pick<Tenant, 'environmentId'>,
  password: string,
  userInfo: PasswordUserInfo = {}
): Promise<PasswordAssessment> {
  const active = await policy(deps, tenant)
  const normalized = normalizePassword(password)
  const failed = evaluatePassword(active, normalized, userInfo).checks.filter((c) => !c.passed)
  const [first] = failed
  if (first) {
    throw new ServiceException(first.code, {
      params: first.params,
      errors: failed.map((check) => fieldError(check.code, check.params)),
    })
  }

  if (active.breachCheck === 'off') {
    return { warnings: [] }
  }
  const status = await deps.breachChecker.check(normalized)
  if (status !== 'breached') {
    return { warnings: [] }
  }
  const breached = fieldError('password.breached')
  if (active.breachCheck === 'block') {
    throw new ServiceException('password.breached', { errors: [breached] })
  }
  return { warnings: [breached] }
}
