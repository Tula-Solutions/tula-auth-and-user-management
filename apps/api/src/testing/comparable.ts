/**
 * A copy of a value in which every `Date` is its ISO string, for `toMatchObject`.
 *
 * **Bun's `toMatchObject` does not compare dates**: `expect({ at: new Date(1) }).toMatchObject({
 * at: new Date(2) })` passes (seen on 1.4.2; `toEqual` does compare them). An assertion about
 * *when* something happened that is written with `toMatchObject` therefore asserts nothing.
 * Passing both sides through this makes it a comparison of strings.
 *
 * Only arrays and plain objects are walked. Anything else (an asymmetric matcher such as
 * `expect.any(String)`, a class instance, a `Map`) is returned as it is.
 *
 * @param value - The received value, or the expected subset.
 * @returns The same shape with its dates as ISO strings.
 *
 * @example
 * ```ts
 * expect(comparable(endpoint)).toMatchObject(comparable({ failingSince: deps.clock.now() }))
 * ```
 */
export function comparable<T>(value: T): T {
  if (value instanceof Date) {
    return value.toISOString() as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => comparable(item)) as T
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, comparable(item)])
    ) as T
  }
  return value
}
