/**
 * Matches a UUID in its canonical hyphenated form, in either case.
 *
 * The one pattern for "is this string worth a database lookup": callers that read an id out of a
 * path or header use it before querying, so a malformed value is a 404 and not a driver error.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
