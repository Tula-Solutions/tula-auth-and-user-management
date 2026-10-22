import {
  BookOpen,
  KeyRound,
  Rocket,
  Server,
  ShieldCheck,
  Smartphone,
  Terminal,
  TriangleAlert,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { REPO_URL } from '~/lib/config'
import { GitHubMark } from './icons'
import { LogoMark } from './logo'

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

/** The icon of each card, by route: a picture to find a card by, not decoration alone. */
const ICONS: Record<string, ComponentType> = {
  '/quickstart/': Rocket,
  '/self-host/': Server,
  '/methods/password/': KeyRound,
  '/methods/sessions/': ShieldCheck,
  '/reference/': BookOpen,
  '/reference/error-codes/': TriangleAlert,
  '/cli/': Terminal,
  '/native-apps/': Smartphone,
}

/**
 * The body of the landing page.
 *
 * @param props - The base path the links are served under.
 * @returns The hero and the cards.
 */
export function Landing({ base }: { base: string }) {
  const prefix = base.replace(/\/$/, '')
  return (
    <div className='shell landing'>
      <section className='hero' aria-labelledby='hero-title'>
        <LogoMark className='hero-mark' />
        <h1 id='hero-title' className='hero-title'>
          Authentication you host. Users you own.
        </h1>
        <p className='hero-lead'>
          Tula Auth is self-hosted authentication and user management, with prebuilt UI, native
          mobile SDKs and data that stays in your database.
        </p>
        <div className='hero-actions'>
          <a className='btn' href={`${prefix}/quickstart/`}>
            Get started
          </a>
          <a className='btn btn-outline' href={REPO_URL}>
            <GitHubMark />
            View on GitHub
          </a>
        </div>
        <div className='hero-command'>
          <span aria-hidden='true'>$</span>
          <code>bunx create-tula@latest</code>
        </div>
      </section>
      <ul className='cards'>
        {LANDING_LINKS.map((link) => {
          const Icon = ICONS[link.route] ?? BookOpen
          return (
            <li key={link.route}>
              <a href={`${prefix}${link.route}`} className='card'>
                <span className='card-icon' aria-hidden='true'>
                  <Icon />
                </span>
                <span className='card-title'>{link.title}</span>
                <span className='card-text'>{link.description}</span>
              </a>
            </li>
          )
        })}
      </ul>
      <p className='landing-foot'>
        <a href={`${prefix}/docs/`}>All of the documentation</a>
      </p>
    </div>
  )
}
