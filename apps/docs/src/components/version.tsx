import { addressOf, type ReleaseInfo, versionBases } from '~/lib/release'

/** What the version marker and the banner need to say which docs a reader is on. */
export interface VersionProps {
  release: ReleaseInfo
  base: string
  route: string
}

/** The address of the same page in the other docs (their start page for the 404 page). */
function siblingOf({ release, base, route }: VersionProps): string {
  return addressOf(versionBases(release, base).siblingBase, route === '/404' ? '/' : route)
}

/**
 * The version in the header: which docs these are and the way to the other. A site with one
 * version draws none (the caller does not render it).
 *
 * @param props - The build's release, base and the page's route.
 * @returns A chip, and for a switchable pair a link to the other docs.
 */
export function VersionMarker(props: VersionProps) {
  const { release } = props
  if (release.channel === 'unreleased') {
    return <span className='version-chip'>unreleased</span>
  }
  const label = release.version === null ? 'released' : `v${release.version}`
  // Before any release carries the site the root is not released docs: nothing to switch to.
  if (release.channel === 'next' && release.version === null) {
    return <span className='version-chip version-chip-current'>next</span>
  }
  const [current, other] = release.channel === 'next' ? ['next', label] : [label, 'next']
  return (
    <span className='version-switch'>
      <span className='version-chip version-chip-current'>{current}</span>
      <a
        data-docs-version=''
        href={siblingOf(props)}
        className='version-link'
        aria-label={`Read the ${other === 'next' ? 'unreleased' : 'released'} docs (${other})`}
      >
        {other}
      </a>
    </span>
  )
}

/**
 * The notice above the header on the development docs, and on a site no release carries yet.
 *
 * @param props - The build's release, base and the page's route.
 * @returns The notice, or `null` for the released docs.
 */
export function VersionBanner(props: VersionProps) {
  const { release } = props
  if (release.channel === 'release') {
    return null
  }
  const label = `v${release.version}`
  return (
    <section
      aria-label='Version notice'
      data-docs-banner={release.channel}
      className='version-banner'
    >
      {release.channel === 'next' ? (
        <>
          These are the unreleased docs, written for the <code>develop</code> branch. They can
          describe things no release has.{' '}
          {release.version === null ? (
            'No release carries them yet.'
          ) : (
            <>
              <a data-docs-version='' href={siblingOf(props)}>
                Read the docs of {label}
              </a>
              .
            </>
          )}
        </>
      ) : (
        <>
          No release carries these docs yet, so this is the development version, from the{' '}
          <code>develop</code> branch. It can change before a release.
        </>
      )}
    </section>
  )
}
