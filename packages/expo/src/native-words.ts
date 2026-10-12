// What a native module's rejection is read for: one word, never its message.

/** The word a native module's rejection carries under `key`, or nothing. */
export function wordOf(thrown: unknown, key: 'code' | 'message'): string {
  if (typeof thrown !== 'object' || thrown === null) {
    return ''
  }
  const word = (thrown as Record<string, unknown>)[key]
  return typeof word === 'string' ? word : ''
}
