import type { OrganizationCheck } from '@tula-tech/contract/custom-claims'
import {
  DOMAINS_MANAGE_PERMISSION,
  INVITATIONS_MANAGE_PERMISSION,
  MEMBERSHIPS_MANAGE_PERMISSION,
  MEMBERSHIPS_READ_PERMISSION,
} from '@tula-tech/contract/organization-permissions'
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useOrganizationList } from '../hooks/use-organization'
import { useClientConfig } from '../hooks/use-password-checklist'
import { formatText } from '../localization'
import { go } from '../navigation'
import { DomainsSection } from './organization-domains'
import { GeneralSection } from './organization-general'
import { InvitationsSection } from './organization-invitations'
import { MembersSection } from './organization-members'
import { Notice, useGuard, useTargetOrganization } from './organization-shared'
import { Heading, type HeadingLevel, Root, Status, useScreenChanged, useUi } from './ui'

/**
 * The tabs of `<OrganizationProfile>`, in the order they are drawn.
 *
 * @example
 * ```tsx
 * <OrganizationProfile section='members' />
 * ```
 */
export const ORGANIZATION_PROFILE_SECTIONS = [
  'general',
  'members',
  'invitations',
  'domains',
] as const

/** One of {@link ORGANIZATION_PROFILE_SECTIONS}. */
export type OrganizationProfileSection = (typeof ORGANIZATION_PROFILE_SECTIONS)[number]

/**
 * Props of {@link OrganizationProfile}.
 *
 * @example
 * ```tsx
 * <OrganizationProfile afterLeaveUrl='/' afterDeleteUrl='/' />
 * ```
 */
export interface OrganizationProfileProps {
  /**
   * The organization to manage. Left out, it is the one the session acts in; a user who is a
   * member of several can name any of them.
   */
  organizationId?: string
  /** The tab to open first. A value this version does not know is said to be unsupported. */
  section?: OrganizationProfileSection
  /**
   * The page an emailed invitation's link leads to. Overrides the provider's `invitationUrl`;
   * without either, the Invitations tab cannot send invitations.
   */
  invitationUrl?: string
  /** Where to go after the user left the organization. */
  afterLeaveUrl?: string
  /** Where to go after the user deleted the organization. */
  afterDeleteUrl?: string
  /** Called after the user left or deleted the organization, before any navigation. */
  onGone?: (kind: 'left' | 'deleted', organizationId: string) => void
  /** Theme tokens, colour scheme and class names for this component. */
  appearance?: Appearance
  /** The level of the title; the section titles are one below. Defaults to 1. */
  headingLevel?: HeadingLevel
}

/** The words of a tab. */
function tabLabel(tab: OrganizationProfileSection, t: ReturnType<typeof useUi>['t']): string {
  switch (tab) {
    case 'members':
      return t.organizationProfile.tabMembers
    case 'invitations':
      return t.organizationProfile.tabInvitations
    case 'domains':
      return t.organizationProfile.tabDomains
    default:
      return t.organizationProfile.tabGeneral
  }
}

/** The tabs a role may see: what it may do there is checked again by the server. */
function visibleTabs(has: (check: OrganizationCheck) => boolean): OrganizationProfileSection[] {
  return ORGANIZATION_PROFILE_SECTIONS.filter((tab) => {
    switch (tab) {
      case 'members':
        return (
          has({ permission: MEMBERSHIPS_READ_PERMISSION }) ||
          has({ permission: MEMBERSHIPS_MANAGE_PERMISSION })
        )
      case 'invitations':
        return has({ permission: INVITATIONS_MANAGE_PERMISSION })
      case 'domains':
        return has({ permission: DOMAINS_MANAGE_PERMISSION })
      default:
        return true
    }
  })
}

/**
 * The profile's tabs and their panels, without a root: `<OrganizationSwitcher>` draws it in a
 * dialog.
 *
 * @param props - As {@link OrganizationProfile}, without appearance.
 * @returns The profile, or the reason there is none (no organization, not a member, loading).
 */
export function OrganizationProfileSections(
  props: Omit<OrganizationProfileProps, 'appearance' | 'headingLevel'>
) {
  const { el, t } = useUi()
  const { navigation } = useTulaContext()
  const config = useClientConfig()
  const list = useOrganizationList()
  const guard = useGuard()
  const target = useTargetOrganization(props.organizationId)
  const [selected, setSelected] = useState<string>(props.section ?? 'general')
  const [gone, setGone] = useState<{
    kind: 'left' | 'deleted'
    name: string
    error: string | null
  } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const base = useId()
  const titleId = useId()
  const tabs = useRef<HTMLDivElement>(null)
  const screen = useScreenChanged(`${target.status}:${gone ? 'gone' : ''}`)
  const { reload, sessionId, organizationId } = target

  // What the user may do is read again when the profile opens: a role changed since the list was
  // last fetched must not leave a control that the server will refuse.
  useEffect(() => {
    void sessionId
    void organizationId
    void reload()
  }, [reload, sessionId, organizationId])

  const onAccessChanged = useCallback(() => {
    void reload()
    setNotice(t.organizationProfile.accessChanged)
  }, [reload, t])

  if (target.status === 'signed-out' || target.status === 'off') {
    return null
  }
  if (gone) {
    return (
      <Notice
        title={t.organizationProfile.title}
        focusTitle
        message={formatText(
          gone.kind === 'left' ? t.organizationProfile.goneLeft : t.organizationProfile.goneDeleted,
          { name: gone.name }
        )}
        error={gone.error}
      />
    )
  }
  if (target.status === 'none') {
    return <Notice title={t.organizationProfile.title} message={t.organizations.profileNone} />
  }
  if (target.status === 'loading') {
    return <Notice title={t.organizationProfile.title} message={t.organizations.loading} />
  }
  if (target.status === 'error') {
    return (
      <Notice
        title={t.organizationProfile.title}
        message={target.error?.message ?? t.organizations.loadFailed}
        action={{ label: t.organizations.retry, onClick: () => void reload() }}
      />
    )
  }
  const { organization } = target
  if (target.status === 'not-member' || organization === null) {
    return (
      <Notice
        title={t.organizationProfile.title}
        focusTitle={screen}
        message={t.organizations.profileNotAMember}
      />
    )
  }
  if (!(ORGANIZATION_PROFILE_SECTIONS as readonly string[]).includes(selected)) {
    // A tab this version does not know: say so, and offer the one it does.
    return (
      <Notice
        title={t.organizationProfile.unsupportedTitle}
        message={t.organizationProfile.unsupportedMessage}
        action={{
          label: t.organizationProfile.unsupportedRestart,
          onClick: () => setSelected('general'),
        }}
      />
    )
  }

  const available = visibleTabs(target.has)
  // A tab the role no longer has (its permissions changed) is the general one.
  const current: OrganizationProfileSection = available.includes(
    selected as OrganizationProfileSection
  )
    ? (selected as OrganizationProfileSection)
    : 'general'
  const choose = (tab: OrganizationProfileSection, focus: boolean) => {
    setSelected(tab)
    setNotice(null)
    if (focus) {
      tabs.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus()
    }
  }
  const onTabKey = (event: KeyboardEvent) => {
    const index = available.indexOf(current)
    const move = (to: number) => {
      event.preventDefault()
      const next = available[(to + available.length) % available.length]
      if (next) {
        choose(next, true)
      }
    }
    switch (event.key) {
      case 'ArrowRight':
        move(index + 1)
        break
      case 'ArrowLeft':
        move(index - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(available.length - 1)
        break
      default:
    }
  }

  const onGone = (kind: 'left' | 'deleted') => {
    const leaving = organization
    props.onGone?.(kind, leaving.id)
    const wasActive = list.activeOrganizationId === leaving.id
    // The organization no longer exists for this user: read the list again, and if the session
    // was acting in it, move the session out (to the personal account where the environment has
    // one, otherwise to another organization).
    void (async () => {
      const current = guard()
      let error: string | null = null
      try {
        await list.reload()
        if (wasActive) {
          const others = (list.organizations ?? []).filter((entry) => entry.id !== leaving.id)
          if (config?.organizations?.personalAccount === true) {
            await list.setActive(null)
          } else if (others[0]) {
            await list.setActive(others[0].id)
          }
        }
      } catch (caught) {
        error = toTulaError(caught).message
      }
      if (current()) {
        setGone({ kind, name: leaving.name, error })
      }
    })()
    go(kind === 'left' ? props.afterLeaveUrl : props.afterDeleteUrl, navigation.navigate)
  }

  const section = {
    organization,
    has: target.has,
    reload,
    onAccessChanged,
  }
  return (
    <section {...el('card', 'tula-card-wide')} aria-labelledby={titleId}>
      <header {...el('header')}>
        <Heading {...el('title')} id={titleId}>
          {t.organizationProfile.title}
        </Heading>
        <p {...el('subtitle')}>{organization.name}</p>
      </header>
      <div
        {...el('tabList')}
        ref={tabs}
        role='tablist'
        aria-label={t.organizationProfile.tabsLabel}
        onKeyDown={onTabKey}
      >
        {available.map((tab) => (
          <button
            key={tab}
            type='button'
            role='tab'
            data-tab={tab}
            id={`${base}-tab-${tab}`}
            aria-selected={tab === current}
            aria-controls={tab === current ? `${base}-panel` : undefined}
            tabIndex={tab === current ? 0 : -1}
            {...el('tab')}
            onClick={() => choose(tab, false)}
          >
            {tabLabel(tab, t)}
          </button>
        ))}
      </div>
      <Status message={notice} tone='neutral' />
      <div
        {...el('tabPanel')}
        role='tabpanel'
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${current}`}
        key={`${sessionId}:${organization.id}:${current}`}
      >
        {current === 'members' ? <MembersSection {...section} /> : null}
        {current === 'invitations' ? (
          <InvitationsSection {...section} invitationUrl={props.invitationUrl} />
        ) : null}
        {current === 'domains' ? <DomainsSection {...section} /> : null}
        {current === 'general' ? <GeneralSection {...section} onGone={onGone} /> : null}
      </div>
    </section>
  )
}

/**
 * Manage an organization: General (its details, rename, leave, delete), Members (roles,
 * removal), Invitations (invite, revoke) and Domains (claim, verify with the emailed code, what
 * a verified domain does). A tab is drawn only where the user's role holds its permission, and
 * the server checks every call again: a refusal because the role changed (or the membership
 * ended) reads the user's organizations again, says the permissions changed, and a user who is
 * no longer a member is told so.
 *
 * It manages the session's active organization unless `organizationId` names one. Leaving or
 * deleting the active organization moves the session to the personal account (or, where the
 * environment has none, to another organization).
 *
 * @param props - The organization, the first tab, destinations and appearance; all optional.
 * @returns The component; nothing while signed out or while organizations are off.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * <SignedIn>
 *   <OrganizationProfile afterLeaveUrl='/' afterDeleteUrl='/' />
 * </SignedIn>
 * ```
 */
export function OrganizationProfile(props: OrganizationProfileProps) {
  const { appearance, headingLevel, ...rest } = props
  return (
    <Root appearance={appearance} headingLevel={headingLevel}>
      <OrganizationProfileSections {...rest} />
    </Root>
  )
}
