import { auth } from '@tula/nextjs/server'
import Link from 'next/link'

/** The public home page: anyone may open it, and it still knows who is signed in. */
export default async function Home() {
  const { isSignedIn } = await auth()
  return (
    <section className='panel' aria-labelledby='home-title'>
      <h1 id='home-title'>Northline</h1>
      <p>
        An example Next.js app. Its sign-up, sign-in and account pages are Tula components, and its
        server knows who is signed in without asking a database.
      </p>
      {isSignedIn ? (
        <p className='row'>
          <Link href='/dashboard' className='button-link'>
            Open the dashboard
          </Link>
        </p>
      ) : (
        <p className='row'>
          <Link href='/sign-in' className='button-link'>
            Sign in
          </Link>
          <Link href='/sign-up' className='button-link quiet'>
            Create an account
          </Link>
        </p>
      )}
    </section>
  )
}
