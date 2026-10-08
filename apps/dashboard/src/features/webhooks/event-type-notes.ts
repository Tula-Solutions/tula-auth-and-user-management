// One line for each event type whose name alone could be taken for something else, shown
// where types are chosen. This is the one file of the webhooks screens that says "hook":
// three of the contract's event types are about hooks, which are not webhooks (GLOSSARY.md),
// and a reader choosing types on a screen about webhooks has to be told so.

const HOOK = 'A hook (a question the server asks your backend before a sign-up)'
const NOT_ASKED = 'Not sent when a hook is asked.'

const NOTES: Record<string, string> = {
  'hook.created': `${HOOK} was registered. ${NOT_ASKED}`,
  'hook.updated': `${HOOK} was changed, switched on or switched off. ${NOT_ASKED}`,
  'hook.deleted': `${HOOK} was removed. ${NOT_ASKED}`,
  'signing_key.rotated':
    'The key that signs this environment’s access tokens was replaced. Not about a webhook signing secret.',
  'webhook_endpoint.secret_rotated':
    'A webhook endpoint’s signing secret was replaced. The event carries when the overlap ends, never a secret.',
  'webhook_endpoint.disabled':
    'The server switched a webhook endpoint off by itself (it answered 410, or failed for five days). Not sent when an operator switches one off: that is webhook_endpoint.updated.',
  'session.reuse_detected':
    'A refresh token that had already been used was presented again, and the server ended every session of that sign-in.',
}

/** The event types that have a note, for the test that holds each to the contract's list. */
export const NOTED_EVENT_TYPES: readonly string[] = Object.keys(NOTES)

/**
 * What an event type is about, in a line, when its name could be misread.
 *
 * @param type - An event type.
 * @returns The note, or nothing for a type whose name says it (and for one nobody knows).
 */
export function eventTypeNote(type: string): string | undefined {
  return Object.hasOwn(NOTES, type) ? NOTES[type] : undefined
}
