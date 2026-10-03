const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * Fill `{{name}}` placeholders in every string of a value.
 *
 * @param value - A string, array or object from a scenario.
 * @param variables - The values known so far.
 * @returns A copy of `value` with every placeholder replaced.
 * @throws Error naming the placeholder when it has no value, so a typo in a scenario fails
 *   loudly instead of sending `{{tpyo}}` to the server.
 */
export function fill<T>(value: T, variables: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_all, name: string) => {
      const found = variables[name]
      if (found === undefined) {
        throw new Error(`no value for {{${name}}}`)
      }
      return found
    }) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => fill(item, variables)) as T
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item, variables)])
    ) as T
  }
  return value
}

/**
 * Replace every `{ "$json": "<JSON text>" }` in a value by the value that text encodes.
 *
 * Variables are strings, so a step that captured an object (`captureJson`) holds its JSON text;
 * this is how a later request body gets the object back. Call it after {@link fill}.
 *
 * @param value - A request body, placeholders already filled in.
 * @returns A copy with each `$json` object replaced.
 * @throws Error when a `$json` value is not a string of valid JSON.
 *
 * @example
 * ```ts
 * expandJson({ settings: { $json: '{"a":1}' } }) // { settings: { a: 1 } }
 * ```
 */
export function expandJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(expandJson)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const entries = Object.entries(value)
  const [only] = entries
  if (entries.length === 1 && only && only[0] === '$json') {
    if (typeof only[1] !== 'string') {
      throw new Error('$json takes a string holding JSON')
    }
    try {
      return JSON.parse(only[1])
    } catch {
      // The text is a captured response value: never quote it.
      throw new Error('$json does not hold valid JSON')
    }
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, expandJson(item)]))
}
