import { createCipheriv, pbkdf2 as nodePbkdf2, scrypt as nodeScrypt } from 'node:crypto'
import type { ErrorCode, FirebaseScryptParams, ImportUserRow } from '@tula-tech/contract'
import type { Deps } from '~/dependencies'
import { timingSafeEqual } from '~/lib/crypto'
import type { SecretBox } from '~/lib/secret-box'

/**
 * Password hashes made by another system, accepted by a user import (ADR 0066).
 *
 * bcrypt and argon2 are read by `Bun.password.verify`; PBKDF2-SHA256 and Firebase's scrypt are
 * verified here. A hash is parsed before it is stored, so that one which cannot be verified,
 * or which is so cheap or so costly that storing it would be a mistake, is refused at import
 * and not discovered at somebody's first sign-in.
 */

/** The `algorithm` names an import row may carry. */
export const IMPORT_ALGORITHMS = [
  'bcrypt',
  'argon2id',
  'argon2i',
  'pbkdf2_sha256',
  'firebase_scrypt',
] as const

/** An algorithm name {@link IMPORT_ALGORITHMS} lists. */
export type ImportAlgorithm = (typeof IMPORT_ALGORITHMS)[number]

/**
 * The cost floors and ceilings of an imported hash (ADR 0066).
 *
 * Floors are OWASP's minimums for each algorithm: bcrypt work factor 10, argon2 19 MiB of
 * memory with 2 passes. Ceilings exist because the cost is the stored hash's, not ours: a
 * hash asking for 4 GiB would turn every sign-in of that account into a denial of service.
 */
export const HASH_LIMITS = {
  bcrypt: { minCost: 10, maxCost: 14 },
  argon2: {
    minMemoryKiB: 19_456,
    maxMemoryKiB: 262_144,
    minTime: 2,
    maxTime: 10,
    minParallelism: 1,
    maxParallelism: 8,
    minSaltBytes: 8,
    minHashBytes: 16,
  },
  /**
   * PBKDF2-HMAC-SHA256. The floor is 100,000 iterations, below OWASP's 600,000 on purpose:
   * the sources whose hashes are imported (Django before 4.2 at 260,000, older exports lower)
   * are real, and the first sign-in replaces the hash with argon2id. Under 100,000 a hash is
   * weak enough that storing it is the mistake. The ceiling bounds one verification to about
   * 135 ms of CPU, which every sign-in of that account pays until it is replaced.
   */
  pbkdf2: {
    minIterations: 100_000,
    maxIterations: 2_000_000,
    minSaltBytes: 8,
    maxSaltBytes: 64,
    minHashBytes: 16,
    maxHashBytes: 64,
  },
  /**
   * Firebase's scrypt (`N = 2^memCost`, `r = rounds`, `p = 1`). Firebase's own parameters
   * are memCost 14 and rounds 8 (16 MiB). `maxMemoryBytes` (`128 * N * r`) is the real
   * ceiling: the pair of ceilings alone would allow 128 MiB, and a hash asking for that
   * would make one sign-in a memory spike, so the product is bounded too.
   */
  scrypt: {
    minMemCost: 12,
    maxMemCost: 16,
    minRounds: 4,
    maxRounds: 16,
    maxMemoryBytes: 64 * 1024 * 1024,
    minSaltBytes: 8,
    maxSaltBytes: 64,
    maxSignerKeyBytes: 128,
    maxSaltSeparatorBytes: 64,
  },
} as const

/** What parsing an imported hash decided. */
export type ParsedHash =
  | {
      ok: true
      algorithm: ImportAlgorithm
      /** What to store in `password_hash`: the hash as given, or its normalized form. */
      stored: string
    }
  | { ok: false; code: Extract<ErrorCode, `import.${string}`> }

type Refused = Extract<ParsedHash, { ok: false }>

/** A row's `params`, as the contract types them. */
type RowParams = Record<string, string | number>

const BCRYPT = /^\$(2[aby])\$(\d{2})\$([./A-Za-z0-9]{53})$/
const ARGON2 =
  /^\$(argon2id|argon2i)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/

/** The stored form of a PBKDF2-SHA256 hash: PHC, with the iteration count as `i=`. */
const PBKDF2_PREFIX = '$pbkdf2-sha256$'
/** The stored form of a Firebase scrypt hash: its parameters sealed, then salt and hash. */
const FIREBASE_PREFIX = '$tula-firebase-scrypt$v1$'
const PBKDF2_STORED = /^\$pbkdf2-sha256\$i=(\d{1,9})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/
const FIREBASE_STORED =
  /^\$tula-firebase-scrypt\$v1\$([A-Za-z0-9_.-]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

/** Purpose label of the sealed Firebase parameters (`~/lib/secret-box`). */
const SEAL_PURPOSE = 'import-hash-parameters'

const refuse = (code: Refused['code']): Refused => ({ ok: false, code })

/**
 * Bytes of a base64 text, strictly: the standard alphabet, padding optional, and only the
 * canonical encoding of those bytes (so a length that no byte string has, or stray bits in the
 * last character, are refused).
 *
 * @param text - The base64 text.
 * @param dots - Read `.` as `+`, which is passlib's "ab64" alphabet.
 * @returns The bytes, or `null` for text that is not base64.
 */
function decodeBase64(text: string, dots = false): Buffer | null {
  const normal = dots ? text.replaceAll('.', '+') : text
  if (!BASE64.test(normal)) {
    return null
  }
  const bytes = Buffer.from(normal, 'base64')
  return bytes.toString('base64').replace(/=+$/, '') === normal.replace(/=+$/, '') ? bytes : null
}

const unpadded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/=+$/, '')

/** Bytes a base64 string without padding decodes to. */
function base64Bytes(text: string): number {
  return Math.floor((text.length * 3) / 4)
}

/**
 * Which algorithm a stored hash is, from its prefix alone.
 *
 * @param stored - A stored password hash.
 * @returns The algorithm, or `null` for a format this server does not know.
 */
export function detect(stored: string): ImportAlgorithm | null {
  if (stored.startsWith('$argon2id$')) {
    return 'argon2id'
  }
  if (stored.startsWith('$argon2i$')) {
    return 'argon2i'
  }
  if (stored.startsWith(PBKDF2_PREFIX)) {
    return 'pbkdf2_sha256'
  }
  if (stored.startsWith(FIREBASE_PREFIX)) {
    return 'firebase_scrypt'
  }
  return /^\$2[aby]\$/.test(stored) ? 'bcrypt' : null
}

/**
 * Parse a hash that came with an import row and judge its parameters, for the algorithms whose
 * hash needs nothing but itself: bcrypt, argon2 and PBKDF2-SHA256. `firebase_scrypt` needs
 * the project's parameters and a seal: use {@link prepare}, which calls this for the rest.
 *
 * PBKDF2-SHA256 is read in these forms and stored in one (`$pbkdf2-sha256$i=N$salt$hash`,
 * PHC, unpadded base64): Django's `pbkdf2_sha256$N$salt$hash` (the salt as the text it is,
 * the hash base64); PHC `$pbkdf2-sha256$i=N[,l=L]$salt$hash`; passlib's
 * `$pbkdf2-sha256$N$salt$hash` (its "ab64" alphabet); or a bare base64 derived key with
 * `params` `{ iterations, salt }` (the salt base64).
 *
 * @param algorithm - The algorithm the row declared.
 * @param encoded - The hash as the other system stored it.
 * @param params - The row's `params`, read by PBKDF2 only.
 * @returns The algorithm and what to store when the hash is well formed and inside the
 *   limits, otherwise the `import.*` code that says why. A declared algorithm that is not the
 *   hash's own is `import.hash_malformed`: believing the declaration would verify with the
 *   wrong rules.
 */
export function parse(algorithm: string, encoded: string, params?: RowParams): ParsedHash {
  if (algorithm === 'pbkdf2_sha256') {
    return parsePbkdf2(encoded, params)
  }
  if (algorithm !== 'bcrypt' && algorithm !== 'argon2id' && algorithm !== 'argon2i') {
    return refuse('import.unsupported_algorithm')
  }
  if (algorithm === 'bcrypt') {
    const match = BCRYPT.exec(encoded)
    if (!match) {
      return refuse('import.hash_malformed')
    }
    const cost = Number(match[2])
    if (cost < HASH_LIMITS.bcrypt.minCost) {
      return refuse('import.hash_parameters_too_weak')
    }
    return cost > HASH_LIMITS.bcrypt.maxCost
      ? refuse('import.hash_parameters_too_costly')
      : { ok: true, algorithm: 'bcrypt', stored: encoded }
  }
  const match = ARGON2.exec(encoded)
  if (!match || match[1] !== algorithm || match[2] !== '19') {
    return refuse('import.hash_malformed')
  }
  const [memory, time, parallelism] = [Number(match[3]), Number(match[4]), Number(match[5])]
  const limits = HASH_LIMITS.argon2
  if (
    base64Bytes(match[6] ?? '') < limits.minSaltBytes ||
    base64Bytes(match[7] ?? '') < limits.minHashBytes ||
    parallelism < limits.minParallelism
  ) {
    return refuse('import.hash_malformed')
  }
  // Argon2 needs at least 8 KiB per lane; a smaller `m` is not a hash any library made.
  if (memory < 8 * parallelism) {
    return refuse('import.hash_malformed')
  }
  if (memory < limits.minMemoryKiB || time < limits.minTime) {
    return refuse('import.hash_parameters_too_weak')
  }
  if (
    memory > limits.maxMemoryKiB ||
    time > limits.maxTime ||
    parallelism > limits.maxParallelism
  ) {
    return refuse('import.hash_parameters_too_costly')
  }
  return { ok: true, algorithm, stored: encoded }
}

interface Pbkdf2Parts {
  iterations: number
  salt: Buffer | null
  hash: Buffer | null
}

const UNREADABLE: Pbkdf2Parts = { iterations: Number.NaN, salt: null, hash: null }

/** Split a PBKDF2-SHA256 hash into its parts, whichever of the accepted forms it is in. */
function pbkdf2Parts(encoded: string, params: RowParams | undefined): Pbkdf2Parts {
  if (encoded.startsWith('pbkdf2_sha256$')) {
    const parts = encoded.split('$')
    const [, count = '', salt = '', hash = ''] = parts
    // Django's salt is the text itself, not an encoding of bytes.
    return parts.length === 4 && /^\d{1,9}$/.test(count) && /^[\x21-\x7e]+$/.test(salt)
      ? { iterations: Number(count), salt: Buffer.from(salt, 'utf8'), hash: decodeBase64(hash) }
      : UNREADABLE
  }
  if (encoded.startsWith(PBKDF2_PREFIX)) {
    const parts = encoded.split('$')
    if (parts.length !== 5) {
      return UNREADABLE
    }
    const [, , setting = '', salt = '', hash = ''] = parts
    const phc = /^i=(\d{1,9})(?:,l=(\d{1,3}))?$/.exec(setting)
    if (phc) {
      const hashBytes = decodeBase64(hash)
      // `l`, when given, is the derived key's length and must be the hash's own.
      if (phc[2] !== undefined && hashBytes?.length !== Number(phc[2])) {
        return UNREADABLE
      }
      return { iterations: Number(phc[1]), salt: decodeBase64(salt), hash: hashBytes }
    }
    return /^\d{1,9}$/.test(setting)
      ? {
          iterations: Number(setting),
          salt: decodeBase64(salt, true),
          hash: decodeBase64(hash, true),
        }
      : UNREADABLE
  }
  if (encoded.includes('$')) {
    return UNREADABLE
  }
  const iterations = params?.iterations
  const salt = params?.salt
  return typeof iterations === 'number' && Number.isInteger(iterations) && typeof salt === 'string'
    ? { iterations, salt: decodeBase64(salt), hash: decodeBase64(encoded) }
    : UNREADABLE
}

function parsePbkdf2(encoded: string, params: RowParams | undefined): ParsedHash {
  const { iterations, salt, hash } = pbkdf2Parts(encoded, params)
  const limits = HASH_LIMITS.pbkdf2
  if (
    !Number.isInteger(iterations) ||
    !salt ||
    !hash ||
    salt.length < limits.minSaltBytes ||
    salt.length > limits.maxSaltBytes ||
    hash.length < limits.minHashBytes ||
    hash.length > limits.maxHashBytes
  ) {
    return refuse('import.hash_malformed')
  }
  if (iterations < limits.minIterations) {
    return refuse('import.hash_parameters_too_weak')
  }
  if (iterations > limits.maxIterations) {
    return refuse('import.hash_parameters_too_costly')
  }
  return {
    ok: true,
    algorithm: 'pbkdf2_sha256',
    stored: `${PBKDF2_PREFIX}i=${iterations}$${unpadded(salt)}$${unpadded(hash)}`,
  }
}

/** What the server needs to open the Firebase parameters kept with a user's hash. */
export interface Opener {
  readonly secretBox: SecretBox
  readonly environmentId: string
  readonly userId: string
}

/**
 * The context a stored Firebase scrypt hash is opened in.
 *
 * @param deps - The secret box.
 * @param environmentId - The user's environment.
 * @param userId - The user the hash belongs to.
 * @returns The opener {@link verify} takes.
 */
export function opener(
  deps: Pick<Deps, 'secretBox'>,
  environmentId: string,
  userId: string
): Opener {
  return { secretBox: deps.secretBox, environmentId, userId }
}

/** Binds the sealed parameters to one user: copied into another row they do not open. */
const sealContext = (o: Pick<Opener, 'environmentId' | 'userId'>) =>
  `import-hash:${o.environmentId}:${o.userId}`

/** The Firebase parameters, validated and decoded. */
interface ScryptParameters {
  signerKey: Buffer
  saltSeparator: Buffer
  rounds: number
  memCost: number
}

function judgeScrypt(project: FirebaseScryptParams | undefined): ScryptParameters | Refused {
  if (!project) {
    return refuse('import.hash_malformed')
  }
  const limits = HASH_LIMITS.scrypt
  const signerKey = decodeBase64(project.signerKey)
  const saltSeparator = decodeBase64(project.saltSeparator)
  const { rounds, memCost } = project
  if (
    !signerKey ||
    signerKey.length === 0 ||
    signerKey.length > limits.maxSignerKeyBytes ||
    !saltSeparator ||
    saltSeparator.length > limits.maxSaltSeparatorBytes ||
    !Number.isInteger(rounds) ||
    !Number.isInteger(memCost)
  ) {
    return refuse('import.hash_malformed')
  }
  if (rounds < limits.minRounds || memCost < limits.minMemCost) {
    return refuse('import.hash_parameters_too_weak')
  }
  if (
    rounds > limits.maxRounds ||
    memCost > limits.maxMemCost ||
    128 * 2 ** memCost * rounds > limits.maxMemoryBytes
  ) {
    return refuse('import.hash_parameters_too_costly')
  }
  return { signerKey, saltSeparator, rounds, memCost }
}

/**
 * Judge an import row's password and say what to store (ADR 0066).
 *
 * For `firebase_scrypt` the project's parameters are sealed with the secret box, bound to the
 * environment and the user, and kept inside the stored hash (`$tula-firebase-scrypt$v1$…`):
 * nothing but the user's row holds them, and the first sign-in's replacement takes them away.
 *
 * @param deps - The secret box.
 * @param user - The environment and the id the user will have.
 * @param password - The row's password.
 * @param firebase - The call's Firebase parameters, read by `firebase_scrypt` rows only.
 * @returns What {@link parse} returns.
 */
export async function prepare(
  deps: Pick<Deps, 'secretBox'>,
  user: { environmentId: string; userId: string },
  password: NonNullable<ImportUserRow['password']>,
  firebase: FirebaseScryptParams | undefined
): Promise<ParsedHash> {
  if (password.algorithm !== 'firebase_scrypt') {
    return parse(password.algorithm, password.hash, password.params)
  }
  const project = judgeScrypt(firebase)
  if ('ok' in project) {
    return project
  }
  const limits = HASH_LIMITS.scrypt
  const salt = typeof password.params?.salt === 'string' ? decodeBase64(password.params.salt) : null
  const hash = decodeBase64(password.hash)
  if (
    !salt ||
    salt.length < limits.minSaltBytes ||
    salt.length > limits.maxSaltBytes ||
    // The hash is the signer key encrypted, so it is as long as the key.
    !hash ||
    hash.length !== project.signerKey.length
  ) {
    return refuse('import.hash_malformed')
  }
  const sealed = await deps.secretBox.seal(
    SEAL_PURPOSE,
    new TextEncoder().encode(
      JSON.stringify({
        k: project.signerKey.toString('base64'),
        s: project.saltSeparator.toString('base64'),
        r: project.rounds,
        m: project.memCost,
      })
    ),
    sealContext(user)
  )
  return {
    ok: true,
    algorithm: 'firebase_scrypt',
    stored: `${FIREBASE_PREFIX}${sealed}$${unpadded(salt)}$${unpadded(hash)}`,
  }
}

/**
 * PBKDF2-HMAC-SHA256, off the event loop.
 *
 * @param password - The password, UTF-8.
 * @param salt - The salt bytes.
 * @param iterations - The iteration count (the caller has judged it).
 * @param length - The derived key's length in bytes.
 * @returns The derived key.
 */
export function pbkdf2Sha256(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodePbkdf2(Buffer.from(password, 'utf8'), salt, iterations, length, 'sha256', (error, key) =>
      error ? reject(error) : resolve(key)
    )
  })
}

/**
 * Firebase's modified scrypt: scrypt of the password with the salt followed by the project's
 * separator (`N = 2^memCost`, `r = rounds`, `p = 1`, 32 bytes) is the AES-256-CTR key, with a
 * zero IV, that encrypts the project's signer key; the result is the hash.
 *
 * @param password - The password, UTF-8.
 * @param salt - The user's salt bytes.
 * @param parameters - The project's parameters, already judged.
 * @returns The hash bytes.
 */
async function firebaseScrypt(
  password: string,
  salt: Uint8Array,
  parameters: ScryptParameters
): Promise<Buffer> {
  const n = 2 ** parameters.memCost
  const key = await new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(
      Buffer.from(password, 'utf8'),
      Buffer.concat([salt, parameters.saltSeparator]),
      32,
      { N: n, r: parameters.rounds, p: 1, maxmem: 2 * 128 * n * parameters.rounds },
      (error, derived) => (error ? reject(error) : resolve(derived))
    )
  })
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16))
  return Buffer.concat([cipher.update(parameters.signerKey), cipher.final()])
}

/**
 * Check a password against a hash in one of the formats {@link prepare} stores.
 *
 * Every failure is a mismatch and never an error: a hash that cannot be read, a Firebase hash
 * with no `context`, parameters that do not open (another user's, or a changed master key) or
 * that are outside the limits (a row edited behind the server's back). The limits are judged
 * again here, since the stored text is only as trusted as the database.
 *
 * @param stored - The stored hash.
 * @param password - The candidate password.
 * @param context - Who the hash belongs to; needed for Firebase hashes only.
 * @returns `true` or `false`, or `null` when `stored` is not one of these formats (the caller
 *   hands it to `Bun.password.verify`).
 */
export async function verify(
  stored: string,
  password: string,
  context?: Opener
): Promise<boolean | null> {
  try {
    if (stored.startsWith(PBKDF2_PREFIX)) {
      const match = PBKDF2_STORED.exec(stored)
      const salt = decodeBase64(match?.[2] ?? '')
      const hash = decodeBase64(match?.[3] ?? '')
      const iterations = Number(match?.[1])
      const limits = HASH_LIMITS.pbkdf2
      if (
        !salt ||
        !hash ||
        !(iterations >= limits.minIterations && iterations <= limits.maxIterations) ||
        hash.length < limits.minHashBytes ||
        hash.length > limits.maxHashBytes
      ) {
        return false
      }
      return timingSafeEqual(await pbkdf2Sha256(password, salt, iterations, hash.length), hash)
    }
    if (stored.startsWith(FIREBASE_PREFIX)) {
      const match = FIREBASE_STORED.exec(stored)
      const salt = decodeBase64(match?.[2] ?? '')
      const hash = decodeBase64(match?.[3] ?? '')
      if (!match?.[1] || !salt || !hash || !context) {
        return false
      }
      const opened = JSON.parse(
        new TextDecoder().decode(
          await context.secretBox.open(SEAL_PURPOSE, match[1], sealContext(context))
        )
      ) as { k: string; s: string; r: number; m: number }
      const parameters = judgeScrypt({
        signerKey: opened.k,
        saltSeparator: opened.s,
        rounds: opened.r,
        memCost: opened.m,
      })
      if ('ok' in parameters || hash.length !== parameters.signerKey.length) {
        return false
      }
      return timingSafeEqual(await firebaseScrypt(password, salt, parameters), hash)
    }
    return null
  } catch {
    return false
  }
}
