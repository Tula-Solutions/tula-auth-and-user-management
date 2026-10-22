import { resolve } from 'node:path'
import { resolveBase, resolveRepoRoot } from './paths'
import { resolveRelease } from './release'

/**
 * The repository root (`DOCS_REPO_ROOT` is for the build script's own test: `paths.ts` says
 * which values it accepts).
 */
export const REPO_ROOT = resolveRepoRoot()

/** The Markdown the site renders: the only source of its content. */
export const DOCS_DIR = resolve(REPO_ROOT, 'docs')

/**
 * Directories of `docs/` the site leaves out: plans and decisions are for contributors and are
 * read in the repository, and the codebase map is a generated snapshot.
 */
export const EXCLUDED_DIRECTORIES = ['plans', 'adr', 'codebase-map'] as const

/**
 * Where a link to a repository file that is not a page of the site (an ADR, a package README, a
 * source file) is sent. A branch name, not a commit: the docs describe the branch they are on.
 */
export const REPO_URL = 'https://github.com/Tula-Solutions/tula-auth-and-user-management'
export const REPO_BRANCH = 'develop'

/**
 * The path the site is served under, with a leading and a trailing slash (`/` at a domain's
 * root). Set `DOCS_BASE` at build time to host it under a sub-path; `resolveBase` in
 * `paths.ts` says which values it accepts.
 */
export const BASE = resolveBase()

/**
 * Which docs this build is (the latest release's, the development branch's under `next/`, or the
 * development branch's at the root while no release has the site), or `null` for a local build.
 * `resolveRelease` in `release.ts` says which values of `DOCS_CHANNEL`, `DOCS_VERSION` and
 * `DOCS_ORIGIN` it accepts.
 */
export const RELEASE = resolveRelease(process.env, BASE)

/** The name shown in the header and in every page's title. */
export const SITE_NAME = 'Tula Auth docs'

/** What the site is, in one sentence: the description of the landing page and of a card. */
export const SITE_DESCRIPTION =
  'Self-hosted authentication and user management with prebuilt UI and native mobile SDKs.'
