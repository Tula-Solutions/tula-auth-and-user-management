import {
  EmailLinkCallback,
  SignedIn,
  SignedOut,
  SignIn,
  SignUp,
  TulaLoading,
  TulaProvider,
  UserButton,
  UserProfile,
  useUser,
} from '@tula/react'
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

// Everything about authentication on this page is a `@tula/react` component or hook. The app
// itself only adds a header, its routes and a theme switch.

/**
 * The page emailed sign-in links lead to. In a deployed app this exact URL is listed in the
 * environment's `urls.allowedRedirectUrls`; a local API allows any loopback URL.
 */
const EMAIL_LINK_PATH = '/auth/link'

const API_URL: string = import.meta.env.VITE_TULA_API_URL ?? 'http://localhost:3003'
const PUBLISHABLE_KEY: string = import.meta.env.VITE_TULA_PUBLISHABLE_KEY ?? ''

type Scheme = 'system' | 'light' | 'dark'
const SCHEMES: Scheme[] = ['system', 'light', 'dark']

/** The smallest router that will do: the path is state, links push history. */
function useRoute(): [string, (url: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const sync = () => setPath(window.location.pathname)
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])
  const navigate = useCallback((url: string) => {
    window.history.pushState(null, '', url)
    setPath(window.location.pathname)
  }, [])
  return [path, navigate]
}

function Link(props: {
  to: string
  navigate(url: string): void
  className?: string
  children: ReactNode
}) {
  const follow = (event: MouseEvent) => {
    if (!(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
      event.preventDefault()
      props.navigate(props.to)
    }
  }
  return (
    <a href={props.to} className={props.className} onClick={follow}>
      {props.children}
    </a>
  )
}

/** Sends the visitor somewhere else once the page has rendered. */
function Redirect(props: { to: string; navigate(url: string): void }) {
  const { to, navigate } = props
  useEffect(() => navigate(to), [to, navigate])
  return null
}

function Home(props: { navigate(url: string): void }) {
  const { user } = useUser()
  return (
    <section className='panel' aria-labelledby='home-title'>
      <h1 id='home-title'>Hello{user ? `, ${user.firstName ?? user.email}` : ''}</h1>
      <p>
        You are signed in to Northline. Your session lives in an httpOnly cookie; this page never
        sees it.
      </p>
      <p>
        <Link to='/account' navigate={props.navigate} className='button-link'>
          Manage your account
        </Link>
      </p>
    </section>
  )
}

function Landing(props: { navigate(url: string): void }) {
  return (
    <section className='panel' aria-labelledby='landing-title'>
      <h1 id='landing-title'>Northline</h1>
      <p>
        An example app whose sign-up, sign-in, password reset and account pages are @tula/react
        components.
      </p>
      <p className='row'>
        <Link to='/sign-in' navigate={props.navigate} className='button-link'>
          Sign in
        </Link>
        <Link to='/sign-up' navigate={props.navigate} className='button-link quiet'>
          Create an account
        </Link>
      </p>
    </section>
  )
}

function Setup() {
  return (
    <main className='page'>
      <section className='panel' aria-labelledby='setup-title'>
        <h1 id='setup-title'>Set a publishable key</h1>
        <p>
          Start this app with <code>VITE_TULA_PUBLISHABLE_KEY</code> (and, if the API is not on{' '}
          <code>http://localhost:3003</code>, <code>VITE_TULA_API_URL</code>). See the README.
        </p>
      </section>
    </main>
  )
}

export function App() {
  const [path, navigate] = useRoute()
  const [scheme, setScheme] = useState<Scheme>('system')

  // The page's own colours follow the same switch as the components'.
  useEffect(() => {
    if (scheme === 'system') {
      document.documentElement.removeAttribute('data-tula-theme')
    } else {
      document.documentElement.setAttribute('data-tula-theme', scheme)
    }
  }, [scheme])

  // A route change replaces the page's content. Move focus to the start of the new content, as
  // a full page load would: otherwise a keyboard user is left wherever the old content was.
  const main = useRef<HTMLElement>(null)
  const firstPath = useRef(path)
  useEffect(() => {
    if (path !== firstPath.current) {
      firstPath.current = ''
      main.current?.focus()
    }
  }, [path])

  if (PUBLISHABLE_KEY === '') {
    return <Setup />
  }

  const auth = path === '/sign-in' || path === '/sign-up' || path === EMAIL_LINK_PATH
  return (
    <TulaProvider
      publishableKey={PUBLISHABLE_KEY}
      baseUrl={API_URL}
      navigate={navigate}
      signInUrl='/sign-in'
      signUpUrl='/sign-up'
      afterSignInUrl='/'
      emailLinkUrl={EMAIL_LINK_PATH}
      afterSignUpUrl='/'
      afterSignOutUrl='/sign-in'
    >
      <header className='top'>
        <Link to='/' navigate={navigate} className='brand'>
          <span className='brand-mark' aria-hidden='true'>
            N
          </span>
          Northline
        </Link>
        <div className='top-actions'>
          <label className='scheme'>
            <span>Theme</span>
            <select value={scheme} onChange={(event) => setScheme(event.target.value as Scheme)}>
              {SCHEMES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <SignedIn>
            <UserButton />
          </SignedIn>
        </div>
      </header>
      <main ref={main} tabIndex={-1} className={auth ? 'page split' : 'page'}>
        <TulaLoading>
          <p className='loading'>Loading…</p>
        </TulaLoading>
        {path === '/sign-up' ? (
          <>
            <SignedOut>
              <SignUp collectName />
            </SignedOut>
            <SignedIn>
              <Redirect to='/' navigate={navigate} />
            </SignedIn>
          </>
        ) : path === '/sign-in' ? (
          <>
            <SignedOut>
              <SignIn />
            </SignedOut>
            <SignedIn>
              <Redirect to='/' navigate={navigate} />
            </SignedIn>
          </>
        ) : path === EMAIL_LINK_PATH ? (
          // Whoever opens an emailed link lands here, signed in or not: the component says
          // what became of the link and sends a signed-in visitor on.
          <EmailLinkCallback />
        ) : path === '/account' ? (
          <>
            <SignedIn>
              <UserProfile />
            </SignedIn>
            <SignedOut>
              <Redirect to='/sign-in' navigate={navigate} />
            </SignedOut>
          </>
        ) : (
          <>
            <SignedIn>
              <Home navigate={navigate} />
            </SignedIn>
            <SignedOut>
              <Landing navigate={navigate} />
            </SignedOut>
          </>
        )}
        {auth ? (
          <aside className='pitch'>
            <p className='pitch-title'>Your brand. Your colors. Their sign-in, done.</p>
            <p>Every screen picks up your theme tokens on web, iOS and Android.</p>
          </aside>
        ) : null}
      </main>
    </TulaProvider>
  )
}
