/** A card of the landing page: where to go, and why. */
export interface LandingLink {
  title: string
  description: string
  /** A route of the site, without the base. */
  route: string
}

/**
 * The places the landing page sends a reader to. Routes, not Markdown paths: the build checks
 * that every one is a page (`site.test.ts`).
 */
export const LANDING_LINKS: readonly LandingLink[] = [
  {
    title: 'Quickstart',
    description:
      'From nothing to a signed-in user: the image, the packages, create-tula, tula dev.',
    route: '/quickstart/',
  },
  {
    title: 'Self-hosting',
    description: 'The server’s settings, an environment’s settings, Redis, proxies, upgrades.',
    route: '/self-host/',
  },
  {
    title: 'Password',
    description:
      'Sign-up, sign-in, reset and the password policy. The first of the sign-in methods.',
    route: '/methods/password/',
  },
  {
    title: 'Sessions',
    description: 'Profiles, devices, the concurrent-session limit and what your server sees.',
    route: '/methods/sessions/',
  },
  {
    title: 'SDK reference',
    description: 'Every public export of the web SDKs, written from their JSDoc.',
    route: '/reference/',
  },
  {
    title: 'Error codes',
    description: 'Every error code the API returns, each with an address you can link to.',
    route: '/reference/error-codes/',
  },
  {
    title: 'Command line',
    description: 'create-tula, tula dev, tula doctor, tula diff, tula apply, tula mcp.',
    route: '/cli/',
  },
  {
    title: 'Native apps',
    description: 'The Swift, Kotlin and Expo SDKs, and how an app is registered with the server.',
    route: '/native-apps/',
  },
]

/**
 * The body of the landing page.
 *
 * @param props - The base path the links are served under.
 * @returns The hero and the cards.
 */
export function Landing({ base }: { base: string }) {
  const prefix = base.replace(/\/$/, '')
  return (
    <div className='mx-auto max-w-4xl'>
      <h1 className='text-4xl font-semibold tracking-tight'>Tula Auth</h1>
      <p className='mt-4 max-w-2xl text-lg text-muted-foreground'>
        Self-hosted authentication and user management, with prebuilt UI, native mobile SDKs and
        data you own. These pages are the documentation that ships with the repository.
      </p>
      <ul className='mt-10 grid list-none gap-4 p-0 sm:grid-cols-2'>
        {LANDING_LINKS.map((link) => (
          <li key={link.route}>
            <a
              href={`${prefix}${link.route}`}
              className='block h-full rounded-lg border bg-card p-5 text-card-foreground no-underline hover:border-input'
            >
              <span className='block text-base font-semibold'>{link.title}</span>
              <span className='mt-1 block text-sm text-muted-foreground'>{link.description}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className='mt-10 text-sm'>
        <a className='text-link underline underline-offset-4' href={`${prefix}/docs/`}>
          All of the documentation
        </a>
      </p>
    </div>
  )
}
