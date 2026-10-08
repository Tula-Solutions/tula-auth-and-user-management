import { auth } from '@tula/nextjs/server'

/** A protected route handler: the proxy answers 401 before this runs when nobody is signed in. */
export async function GET(): Promise<Response> {
  const { isSignedIn, userId, sessionId } = await auth()
  if (!isSignedIn) {
    return Response.json({ status: 401, code: 'auth.unauthenticated' }, { status: 401 })
  }
  return Response.json({ userId, sessionId }, { headers: { 'cache-control': 'no-store' } })
}
