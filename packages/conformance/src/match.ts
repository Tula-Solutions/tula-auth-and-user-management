/** One way a response differed from what a step expects. */
export interface Mismatch {
  /** Dot path into the body, e.g. `step.status`; empty for the body itself. */
  path: string
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Longest string a message quotes. Tokens, keys and JWTs are all longer. */
const MAX_SHOWN_LENGTH = 40

function isSecretShaped(value: string): boolean {
  return value.length > MAX_SHOWN_LENGTH || /^(tula_(rt|sk|pk)_|eyJ)/.test(value)
}

/**
 * Describe a value for a failure message without ever quoting a secret.
 *
 * Messages end up in CI logs. Short plain values (error codes, statuses, ids) are quoted because
 * they are what explains a failure; long or token-shaped strings are described by length, and
 * objects and arrays by kind, since either can hold a token.
 */
function show(value: unknown): string {
  if (value === undefined) {
    return 'nothing'
  }
  if (typeof value === 'string') {
    return isSecretShaped(value) ? `a string of ${value.length} characters` : JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `an array of ${value.length}`
  }
  return typeof value === 'object' && value !== null ? 'an object' : JSON.stringify(value)
}

/** `got …`, saying "different" when both sides are described rather than quoted. */
function got(expected: unknown, actual: unknown): string {
  const [wanted, found] = [show(expected), show(actual)]
  return wanted === found ? `got a different ${found.replace(/^an? /, '')}` : `got ${found}`
}

/**
 * `{ "$set": [...] }`: an array holding exactly these members, in any order. For values that
 * are sets on the wire, such as a token's `amr`, where order is not part of the contract.
 */
function matchSet(members: unknown, actual: unknown, path: string): Mismatch[] {
  const at = path || 'body'
  if (!Array.isArray(members)) {
    return [{ path, message: `${at}: $set takes an array` }]
  }
  const remaining = Array.isArray(actual) ? [...actual] : null
  const matched =
    remaining !== null &&
    remaining.length === members.length &&
    members.every((member) => {
      const index = remaining.findIndex((candidate) => match(member, candidate).length === 0)
      if (index >= 0) {
        remaining.splice(index, 1)
      }
      return index >= 0
    })
  return matched
    ? []
    : [
        {
          path,
          message: `expected ${at} to hold exactly the ${members.length} given members in any order, got ${show(actual)}`,
        },
      ]
}

/**
 * Compare a response body with a step's expected body.
 *
 * Objects are matched as subsets (extra keys in `actual` are fine); arrays must have the same
 * length and match item by item; everything else is compared literally. The matchers `"$any"`,
 * `"$absent"`, `{ "$not": value }`, `{ "$matches": "regex" }` and `{ "$set": [...] }` (an array
 * with exactly these members in any order) are described on `ExpectSchema`.
 *
 * Messages never quote a long or token-shaped string, an object or an array: they are read in
 * CI logs, and response bodies hold tokens.
 *
 * @param expected - The expected body, with placeholders already filled in.
 * @param actual - The body the server returned.
 * @param path - Where in the body this comparison is; callers leave it out.
 * @returns Every difference found; empty when the body matches.
 *
 * @example
 * ```ts
 * match({ step: { status: 'complete' }, session: '$any' }, body) // []
 * ```
 */
export function match(expected: unknown, actual: unknown, path = ''): Mismatch[] {
  const at = path || 'body'
  if (expected === '$any') {
    return actual === undefined || actual === null
      ? [{ path, message: `expected ${at} to be present` }]
      : []
  }
  if (expected === '$absent') {
    return actual === undefined || actual === null
      ? []
      : [{ path, message: `expected ${at} to be absent, got ${show(actual)}` }]
  }
  if (isRecord(expected) && ('$not' in expected || '$matches' in expected || '$set' in expected)) {
    if (Object.keys(expected).length !== 1) {
      return [{ path, message: `${at}: a matcher object takes exactly one key` }]
    }
    if ('$set' in expected) {
      return matchSet(expected.$set, actual, path)
    }
    if ('$not' in expected) {
      // "Not the old token" must not pass because the field vanished.
      if (actual === undefined || actual === null) {
        return [{ path, message: `expected ${at} to be present` }]
      }
      return match(expected.$not, actual, path).length === 0
        ? [{ path, message: `expected ${at} not to be ${show(expected.$not)}` }]
        : []
    }
    const pattern = String(expected.$matches)
    return typeof actual === 'string' && new RegExp(pattern).test(actual)
      ? []
      : [
          {
            path,
            // A pattern built from a captured value could itself be a token.
            message: `expected ${at} to match ${
              isSecretShaped(pattern) ? 'the pattern' : `/${pattern}/`
            }, got ${show(actual)}`,
          },
        ]
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return [{ path, message: `expected ${at} to be ${show(expected)}, got ${show(actual)}` }]
    }
    return expected.flatMap((item, index) => match(item, actual[index], `${path}[${index}]`))
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      return [{ path, message: `expected ${at} to be an object, got ${show(actual)}` }]
    }
    return Object.entries(expected).flatMap(([key, value]) =>
      match(value, actual[key], path ? `${path}.${key}` : key)
    )
  }
  return expected === actual
    ? []
    : [{ path, message: `expected ${at} to be ${show(expected)}, ${got(expected, actual)}` }]
}

/**
 * Read a value out of a body by dot path.
 *
 * @param body - The response body.
 * @param path - A path such as `session.refreshToken` or `data[0].id`.
 * @returns The value, or `undefined` when any part of the path is missing.
 */
export function pick(body: unknown, path: string): unknown {
  let current = body
  for (const part of path.split(/[.[\]]/).filter(Boolean)) {
    if (Array.isArray(current)) {
      current = current[Number(part)]
    } else if (isRecord(current)) {
      current = current[part]
    } else {
      return undefined
    }
  }
  return current
}

/**
 * Read the claims of a JWT without verifying it, as a client does to learn when its token
 * expires or how the user signed in.
 *
 * @param token - A compact JWT (`header.payload.signature`).
 * @returns The payload object, or `undefined` when `token` is not a JWT with a JSON object
 *   payload.
 *
 * @example
 * ```ts
 * jwtClaims(body.session.accessToken) // { sub: '…', amr: ['pwd', 'otp', 'mfa'], … }
 * ```
 */
export function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3 || !parts[1]) {
    return undefined
  }
  try {
    const binary = atob(parts[1].replaceAll('-', '+').replaceAll('_', '/'))
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
    )
    return isRecord(payload) ? payload : undefined
  } catch {
    return undefined
  }
}
