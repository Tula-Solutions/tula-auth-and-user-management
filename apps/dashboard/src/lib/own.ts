/**
 * Read an entry of a table by a key the server chose.
 *
 * A plain object also answers for `constructor`, `toString` and `__proto__`, with a function
 * or its prototype. A table of the dashboard's words is indexed by text from the server (a
 * state, a reason, a code), so only what the table itself holds counts: anything else is a
 * word this version does not know.
 *
 * @param table - The table, a plain object.
 * @param key - The key, as the server gave it.
 * @returns The table's own entry; `undefined` when it has none under that key.
 */
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}
