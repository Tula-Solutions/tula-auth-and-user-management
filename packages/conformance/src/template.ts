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
