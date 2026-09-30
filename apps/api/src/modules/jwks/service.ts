import { ACCESS_TOKEN_ALGORITHM, type Jwk, type Jwks } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { ConflictError, InternalError, NotFoundError } from '~/exceptions'
import * as logger from '~/lib/logger'
import type { SigningKey } from '~/modules/jwks/schema'
import type { NewSigningKey, SigningKeyStatus } from '~/ports/signing-key-store'

/** Secret-box purpose for signing keys; separates their encryption key from other secrets. */
export const SECRET_BOX_PURPOSE = 'signing-keys'

/**
 * How long a `next` key must be published before rotation may activate it. Must exceed the
 * public JWKS `max-age` plus the server's key cache TTL (60s), so every verifier has seen the key
 * before it signs anything.
 */
export const NEXT_KEY_MIN_AGE_MS = 10 * 60_000

/** `Cache-Control: max-age` of the public JWKS. See {@link NEXT_KEY_MIN_AGE_MS}. */
export const JWKS_MAX_AGE_SECONDS = 300

type KeyDeps = Pick<Deps, 'signingKeys' | 'environments' | 'secretBox' | 'ids' | 'clock'>

/**
 * Associated data that binds a sealed private key to its row, so a ciphertext copied into another
 * key or environment fails to decrypt.
 *
 * @param keyId - The signing-key id (kid).
 * @param environmentId - Its environment.
 * @returns The AAD string.
 */
export function ciphertextAad(keyId: string, environmentId: string): string {
  return `signing-key:${keyId}:environment:${environmentId}`
}

async function generate(
  deps: Pick<Deps, 'secretBox' | 'ids'>,
  environment: { id: string; projectId: string },
  status: Exclude<SigningKeyStatus, 'retired'>,
  now: Date
): Promise<NewSigningKey> {
  const id = deps.ids.next()
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  // WebCrypto's typings return a union; asymmetric algorithms always produce a pair.
  if (!('privateKey' in pair)) {
    throw new InternalError({ internalMessage: 'Ed25519 generateKey did not return a key pair' })
  }
  const [pkcs8, publicJwk] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
    crypto.subtle.exportKey('jwk', pair.publicKey),
  ])
  // Build the public JWK field by field so nothing private (`d`) can ever slip into it.
  const jwk: Jwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: String(publicJwk.x),
    kid: id,
    alg: ACCESS_TOKEN_ALGORITHM,
    use: 'sig',
  }
  return {
    id,
    projectId: environment.projectId,
    environmentId: environment.id,
    status,
    publicJwk: jwk,
    privateKeyCiphertext: await deps.secretBox.seal(
      SECRET_BOX_PURPOSE,
      new Uint8Array(pkcs8),
      ciphertextAad(id, environment.id)
    ),
    createdAt: now,
    activatedAt: status === 'active' ? now : null,
  }
}

async function requireEnvironment(deps: Pick<Deps, 'environments'>, environmentId: string) {
  const environment = await deps.environments.findById(environmentId)
  if (!environment) {
    throw new NotFoundError()
  }
  return environment
}

/**
 * Make sure an environment has an `active` and a `next` key, creating whichever is missing.
 *
 * Safe to run concurrently on many instances: the store allows one key per slot, so racing
 * writers lose quietly and the winner's keys are used.
 *
 * @param deps - Stores, secret box, ids and clock.
 * @param environmentId - The environment.
 * @throws NotFoundError for an unknown environment.
 */
export async function ensureKeys(deps: KeyDeps, environmentId: string): Promise<void> {
  const environment = await requireEnvironment(deps, environmentId)
  const keys = await deps.signingKeys.list(environmentId)
  const missing = (['active', 'next'] as const).filter(
    (status) => !keys.some((key) => key.status === status)
  )
  if (missing.length === 0) {
    return
  }
  const now = deps.clock.now()
  const created = await Promise.all(
    missing.map((status) => generate(deps, environment, status, now))
  )
  await deps.signingKeys.insert(environmentId, created)
}

// Imported private keys. The cache key includes everything the AAD binds (kid and environment)
// plus the ciphertext: a hit therefore means this exact binding already decrypted successfully,
// so a ciphertext copied into another row still has to pass the AAD check. The ciphertext also
// keeps entries unique across app instances whose id generators could repeat a kid.
const privateKeys = new Map<string, Promise<CryptoKey>>()

/**
 * The key to sign an environment's access tokens with, bootstrapping keys on first use.
 *
 * The private key is decrypted once per kid and held as a non-extractable `CryptoKey`.
 *
 * @param deps - Stores, secret box, ids and clock.
 * @param environmentId - The environment.
 * @returns The active key's kid and private key.
 * @throws NotFoundError for an unknown environment; InternalError if no key can be established.
 */
export async function activeSigningKey(
  deps: KeyDeps,
  environmentId: string
): Promise<{ kid: string; privateKey: CryptoKey }> {
  let active = (await deps.signingKeys.list(environmentId)).find((key) => key.status === 'active')
  if (!active) {
    await ensureKeys(deps, environmentId)
    active = (await deps.signingKeys.list(environmentId)).find((key) => key.status === 'active')
  }
  if (!active) {
    throw new InternalError({ internalMessage: 'no active signing key after bootstrap' })
  }
  const { id, privateKeyCiphertext } = active
  const aad = ciphertextAad(id, environmentId)
  const cacheKey = `${aad}:${privateKeyCiphertext}`
  let privateKey = privateKeys.get(cacheKey)
  if (!privateKey) {
    privateKey = deps.secretBox
      .open(SECRET_BOX_PURPOSE, privateKeyCiphertext, aad)
      .then((pkcs8) =>
        crypto.subtle.importKey('pkcs8', new Uint8Array(pkcs8), { name: 'Ed25519' }, false, [
          'sign',
        ])
      )
    privateKeys.set(cacheKey, privateKey)
    privateKey.catch(() => privateKeys.delete(cacheKey))
  }
  return { kid: id, privateKey: await privateKey }
}

/**
 * The public key set verifiers fetch: `next`, `active` and recently retired keys.
 *
 * - The environment is checked first so only real environment ids reach the key cache (which is
 *   keyed by environment and would otherwise grow with arbitrary ids from this public route).
 * - An environment created after boot is bootstrapped here, so its keys are published before the
 *   first token is signed and no verifier caches an empty set.
 *
 * @param deps - Stores, secret box, ids and clock.
 * @param environmentId - The environment.
 * @returns The JWKS.
 * @throws NotFoundError for an unknown environment.
 */
export async function publicKeySet(deps: KeyDeps, environmentId: string): Promise<Jwks> {
  await requireEnvironment(deps, environmentId)
  let keys = await deps.signingKeys.verificationKeys(environmentId, deps.clock.now())
  if (keys.length === 0) {
    await ensureKeys(deps, environmentId)
    keys = await deps.signingKeys.verificationKeys(environmentId, deps.clock.now())
  }
  return { keys }
}

function toSigningKey(key: SigningKey): SigningKey {
  return {
    id: key.id,
    status: key.status,
    createdAt: key.createdAt,
    activatedAt: key.activatedAt,
    retiredAt: key.retiredAt,
  }
}

/**
 * List the tenant environment's signing keys (lifecycle metadata only).
 *
 * @param deps - Signing-key store.
 * @param tenant - The resolved tenant.
 * @returns The keys, newest first.
 */
export async function listKeys(
  deps: Pick<Deps, 'signingKeys'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<SigningKey[]> {
  return (await deps.signingKeys.list(tenant.environmentId)).map(toSigningKey)
}

/**
 * Rotate the tenant environment's keys: `active → retired`, `next → active`, new `next`.
 *
 * Refused while the `next` key is younger than {@link NEXT_KEY_MIN_AGE_MS}, so verifiers with a
 * cached key set never meet a token signed by a key they have not seen.
 *
 * @param deps - Stores, secret box, ids and clock.
 * @param tenant - The resolved tenant.
 * @returns The keys after rotation, newest first.
 * @throws ConflictError while the next key is too new (`params.retryAfter` in seconds) or when a
 *   concurrent rotation won.
 */
export async function rotate(deps: KeyDeps, tenant: Tenant): Promise<SigningKey[]> {
  await ensureKeys(deps, tenant.environmentId)
  const environment = await requireEnvironment(deps, tenant.environmentId)
  const keys = await deps.signingKeys.list(tenant.environmentId)
  const active = keys.find((key) => key.status === 'active')
  const next = keys.find((key) => key.status === 'next')
  if (!active || !next) {
    throw new ConflictError({ internalMessage: 'keys changed during rotation' })
  }
  const now = deps.clock.now()
  const waitMs = next.createdAt.getTime() + NEXT_KEY_MIN_AGE_MS - now.getTime()
  if (waitMs > 0) {
    throw new ConflictError({
      message: 'The next signing key was published too recently to activate. Try again later.',
      params: { retryAfter: Math.ceil(waitMs / 1000) },
    })
  }
  const rotated = await deps.signingKeys.rotate(
    tenant.environmentId,
    {
      retireId: active.id,
      activateId: next.id,
      next: await generate(deps, environment, 'next', now),
    },
    now
  )
  if (!rotated) {
    throw new ConflictError({ message: 'Another rotation happened at the same time. Try again.' })
  }
  logger.info('signing keys rotated', {
    environmentId: tenant.environmentId,
    retired: active.id,
    activated: next.id,
  })
  return listKeys(deps, tenant)
}

/**
 * Boot-time bootstrap: ensure every environment has keys before the instance takes traffic.
 *
 * Failures are logged and counted, not thrown, so one broken environment cannot stop boot; its
 * keys are created lazily on first use instead.
 *
 * @param deps - Stores, secret box, ids and clock.
 * @returns How many environments were ensured and how many failed.
 */
export async function ensureAllEnvironments(
  deps: KeyDeps
): Promise<{ ensured: number; failed: number }> {
  let ensured = 0
  let failed = 0
  for (const environment of await deps.environments.listAll()) {
    try {
      await ensureKeys(deps, environment.id)
      ensured += 1
    } catch (error) {
      failed += 1
      logger.error('signing key bootstrap failed', {
        environmentId: environment.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { ensured, failed }
}
