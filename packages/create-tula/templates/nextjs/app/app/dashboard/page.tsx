import { auth, currentUser } from '@tula/nextjs/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { SessionCheckForm } from './session-check'

/**
 * A protected page, rendered on the server. The proxy lets only signed-in requests through;
 * the page checks again, because a page must not depend on the proxy's matcher covering it.
 */
export default async function Dashboard() {
  const { isSignedIn, userId, sessionId, claims } = await auth()
  if (!isSignedIn) {
    redirect('/sign-in?redirect_url=%2Fdashboard')
  }
  const user = await currentUser()
  return (
    <section className='panel' aria-labelledby='dashboard-title'>
      <h1 id='dashboard-title'>Hello{user ? `, ${user.firstName ?? user.email}` : ''}</h1>
      <p>This page was rendered on the server, which verified your session offline.</p>
      <dl className='facts'>
        <dt>Email</dt>
        <dd data-testid='server-email'>{user?.email ?? 'unknown'}</dd>
        <dt>User id</dt>
        <dd data-testid='server-user-id'>{userId}</dd>
        <dt>Session id</dt>
        <dd data-testid='server-session-id'>{sessionId}</dd>
        <dt>Token expires</dt>
        <dd data-testid='server-token-expiry'>{new Date(claims.exp * 1000).toISOString()}</dd>
      </dl>
      <SessionCheckForm />
      <p className='row'>
        <Link href='/profile' className='button-link'>
          Manage your account
        </Link>
      </p>
    </section>
  )
}
