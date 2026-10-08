import { EmailLinkCallback } from '@tula/nextjs'

/**
 * The page an emailed sign-in link leads to (`emailLinkUrl` in the layout). The link's token
 * is in the URL fragment, which never reaches this server: the component reads it in the
 * browser and sends it to the API through the route handler. Whoever opens a link lands here,
 * signed in or not, so the proxy leaves this route public.
 *
 * In a deployed app this exact URL is listed in the environment's `urls.allowedRedirectUrls`;
 * a local API allows any loopback URL.
 */
export default function EmailLinkPage() {
  return <EmailLinkCallback />
}
