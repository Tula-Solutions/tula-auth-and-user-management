/** One way a response differed from what a step expects. */
export interface Mismatch {
  /** Dot path into the body, e.g. `step.status`; empty for the body itself. */
  path: string
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value)
}

/**
 * Compare a response body with a step's expected body.
 *
 * Objects are matched as subsets (extra keys in `actual` are fine); arrays must have the same
 * length and match item by item; everything else is compared literally. The matchers `"$any"`,
 * `"$absent"`, `{ "$not": value }` and `{ "$matches": "regex" }` are described on `ExpectSchema`.
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
  if (isRecord(expected) && '$not' in expected) {
    return match(expected.$not, actual, path).length === 0
      ? [{ path, message: `expected ${at} not to be ${show(expected.$not)}` }]
      : []
  }
  if (isRecord(expected) && '$matches' in expected) {
    const pattern = String(expected.$matches)
    return typeof actual === 'string' && new RegExp(pattern).test(actual)
      ? []
      : [{ path, message: `expected ${at} to match /${pattern}/, got ${show(actual)}` }]
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
    : [{ path, message: `expected ${at} to be ${show(expected)}, got ${show(actual)}` }]
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
