import { ORGANIZATION_INVITATION_TOKEN_PARAM } from '@tula-tech/contract/headers'

/** An invitation's token as read from the URL of an emailed link. */
export interface InvitationLink {
  /** The token to pass to `organizations.invitations.preview`, `accept` or `decline`. */
  token: string
  /** The URL without the token, to put back in the address bar so the token is not kept. */
  cleanUrl: string
}

/**
 * Read the invitation token from the URL an emailed invitation link leads to.
 *
 * The token travels in the URL fragment (`#tula_invitation=…`), which a browser never sends to
 * a server, so it is in no log and in no `Referer`. Read it, then replace the address bar with
 * `cleanUrl` (`history.replaceState`) so that the token is not left in the history.
 *
 * @param url - The page's URL, e.g. `window.location.href`.
 * @returns The token and the URL without it, or `null` when the URL carries no token.
 *
 * @example
 * ```ts
 * const link = readInvitationLink(window.location.href)
 * if (link) {
 *   history.replaceState(null, '', link.cleanUrl)
 *   const { organizationName } = await tula.organizations.invitations.preview(link.token)
 * }
 * ```
 */
export function readInvitationLink(url: string): InvitationLink | null {
  const at = url.indexOf('#')
  if (at === -1) {
    return null
  }
  const fragment = new URLSearchParams(url.slice(at + 1))
  const token = fragment.get(ORGANIZATION_INVITATION_TOKEN_PARAM)
  if (!token) {
    return null
  }
  fragment.delete(ORGANIZATION_INVITATION_TOKEN_PARAM)
  const rest = fragment.toString()
  return { token, cleanUrl: `${url.slice(0, at)}${rest ? `#${rest}` : ''}` }
}
