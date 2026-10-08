'use server'

import { auth, currentUser } from '@tula/nextjs/server'

/** What the server action answers. */
export interface SessionCheck {
  /** Who the server says is signed in, or `null`. */
  email: string | null
  /** When the server looked. */
  checkedAt: string
}

/**
 * A server action that needs a session. The proxy has already refreshed the token for this
 * request; the action still asks `auth()` itself, because an action is a public endpoint.
 */
export async function checkSession(): Promise<SessionCheck> {
  const { isSignedIn } = await auth()
  const user = isSignedIn ? await currentUser() : null
  return { email: user?.email ?? null, checkedAt: new Date().toISOString() }
}
