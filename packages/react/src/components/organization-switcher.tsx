import type {
  InvitationPreview,
  OrganizationSuggestion,
  TulaError,
  UserOrganization,
} from '@tula-tech/core'
import { useEffect, useId, useRef, useState } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from '../hooks/use-auth-state'
import { useOrganizationList } from '../hooks/use-organization'
import { useClientConfig } from '../hooks/use-password-checklist'
import { formatText } from '../localization'
import { go } from '../navigation'
import { CheckIcon, ChevronIcon, CloseIcon } from './icons'
import { CreateOrganizationForm } from './organization-create'
import { OrganizationProfileSections } from './organization-profile'
import { useGuard } from './organization-shared'
import { Button, FormError, Root, Status, useUi } from './ui'

/**
 * Props of {@link OrganizationSwitcher}.
 *
 * @example
 * ```tsx
 * <OrganizationSwitcher onSwitch={() => router.refresh()} />
 * ```
 */
export interface OrganizationSwitcherProps {
  /**
   * Called after the session's active organization changed: the organization's id, or `null`
   * for the personal account. Refresh whatever your app reads from the session here (your
   * router's `refresh`, a query client's `invalidateQueries`).
   */
  onSwitch?: (organizationId: string | null) => void
  /**
   * The token of an invitation the user opened (`readInvitationLink(window.location.href)` on
   * the page the emailed link leads to). The switcher shows what it offers, with "Accept" and
   * "Decline". The server decides again: only the invited account, with its address verified,
   * may answer.
   */
  invitationToken?: string
  /**
   * Called once the invitation was answered, so that the app can forget the token (and keep it
   * out of the address bar).
   */
  onInvitationHandled?: (outcome: 'accepted' | 'declined') => void
  /**
   * Where `<OrganizationProfile>` lives. Overrides the provider's `organizationProfileUrl`;
   * without either, "Manage organization" opens the profile in a dialog.
   */
  organizationProfileUrl?: string
  /**
   * Where `<CreateOrganization>` lives. Overrides the provider's `createOrganizationUrl`;
   * without either, "Create organization" opens the form in a dialog.
   */
  createOrganizationUrl?: string
  /** Theme tokens, colour scheme and class names for this component. */
  appearance?: Appearance
}

/** What the invitation the app handed over is doing. */
type InvitationState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; preview: InvitationPreview }
  | { status: 'failed'; error: TulaError }

function OrganizationSwitcherParts(props: OrganizationSwitcherProps) {
  const { el, t } = useUi()
  const { client, navigation } = useTulaContext()
  const state = useAuthState(client)
  const config = useClientConfig()
  const list = useOrganizationList()
  const guard = useGuard()
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'profile' | 'create' | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<TulaError | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<OrganizationSuggestion[] | null>(null)
  const [invitation, setInvitation] = useState<InvitationState>({ status: 'none' })
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const dialogElement = useRef<HTMLDialogElement>(null)
  const panelId = useId()
  const sessionId = state.status === 'signed-in' ? state.sessionId : null
  const enabled = sessionId !== null && config?.organizations?.enabled === true
  const loaded = list.organizations !== null
  const { invitationToken } = props

  // What the app handed over is asked about once per token and session; a result for another
  // session or another token is dropped.
  useEffect(() => {
    // Named so that another session, which changes nothing else, asks again.
    void sessionId
    if (!enabled || !invitationToken) {
      setInvitation({ status: 'none' })
      return
    }
    let current = true
    setInvitation({ status: 'loading' })
    client.organizations.invitations.preview(invitationToken).then(
      (preview) => {
        if (current) {
          setInvitation({ status: 'ready', preview })
        }
      },
      (caught) => {
        if (current) {
          setInvitation({ status: 'failed', error: toTulaError(caught) })
        }
      }
    )
    return () => {
      current = false
    }
  }, [client, enabled, sessionId, invitationToken])

  // Opening the panel asks which organizations the user's verified address may join.
  useEffect(() => {
    if (!open || !enabled) {
      return
    }
    const current = guard()
    client.organizations.suggestions().then(
      (answer) => {
        if (current()) {
          setSuggestions(answer.data)
        }
      },
      (caught) => {
        if (current()) {
          setError(toTulaError(caught))
        }
      }
    )
  }, [open, enabled, client, guard])

  // A click or a focus move anywhere outside closes the panel.
  useEffect(() => {
    if (!open) {
      return
    }
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    // Escape closes the panel and gives the focus back to the button that opened it.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && container.current?.contains(document.activeElement)) {
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  // Opening the panel moves the focus into it (again when the list arrives late).
  useEffect(() => {
    void loaded
    if (open && !panel.current?.contains(document.activeElement)) {
      panel.current?.querySelector<HTMLElement>('button')?.focus()
    }
  }, [open, loaded])

  useEffect(() => {
    const element = dialogElement.current
    if (dialog !== null && element && typeof element.showModal === 'function' && !element.open) {
      // A modal `<dialog>` traps focus, closes on Escape and dims the page natively.
      element.showModal()
    }
  }, [dialog])

  if (!enabled) {
    return null
  }
  const organizations = list.organizations
  const active = organizations?.find((entry) => entry.id === list.activeOrganizationId) ?? null
  const personal = config?.organizations?.personalAccount === true
  const name =
    active?.name ??
    (list.activeOrganizationId === null && personal
      ? t.organizations.personalAccount
      : t.organizations.switcherLabel)
  const waiting = invitation.status === 'ready'
  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) {
      trigger.current?.focus()
    }
  }

  const choose = async (next: UserOrganization | null) => {
    if (pending !== null) {
      return
    }
    if ((next?.id ?? null) === list.activeOrganizationId) {
      close(true)
      return
    }
    const current = guard()
    setPending('switch')
    setError(null)
    try {
      await list.setActive(next?.id ?? null)
      if (current()) {
        setSaid(
          next === null
            ? t.organizations.switchedToPersonal
            : formatText(t.organizations.switchedTo, { name: next.name })
        )
        close(true)
        props.onSwitch?.(next?.id ?? null)
      }
    } catch (caught) {
      if (current()) {
        setError(toTulaError(caught))
      }
    } finally {
      if (current()) {
        setPending(null)
      }
    }
  }
  const join = async (suggestion: OrganizationSuggestion) => {
    const current = guard()
    setPending(`join:${suggestion.id}`)
    setError(null)
    try {
      await client.organizations.join(suggestion.id)
      await list.reload()
      if (current()) {
        setSuggestions((entries) => (entries ?? []).filter((entry) => entry.id !== suggestion.id))
        setSaid(formatText(t.organizationSwitcher.joined, { name: suggestion.name }))
      }
    } catch (caught) {
      if (current()) {
        setError(toTulaError(caught))
      }
    } finally {
      if (current()) {
        setPending(null)
      }
    }
  }
  const answer = async (outcome: 'accepted' | 'declined') => {
    if (invitation.status !== 'ready' || !invitationToken) {
      return
    }
    const { preview } = invitation
    const current = guard()
    setPending(`invitation:${outcome}`)
    setError(null)
    try {
      if (outcome === 'accepted') {
        await client.organizations.invitations.accept(invitationToken)
        await list.reload()
      } else {
        await client.organizations.invitations.decline(invitationToken)
      }
      if (current()) {
        setInvitation({ status: 'none' })
        setSaid(
          outcome === 'accepted'
            ? formatText(t.organizationSwitcher.joined, { name: preview.organizationName })
            : t.organizationSwitcher.invitationDeclined
        )
        props.onInvitationHandled?.(outcome)
      }
    } catch (caught) {
      if (current()) {
        setError(toTulaError(caught))
      }
    } finally {
      if (current()) {
        setPending(null)
      }
    }
  }
  const manage = () => {
    close(false)
    if (
      !go(props.organizationProfileUrl ?? navigation.organizationProfileUrl, navigation.navigate)
    ) {
      setDialog('profile')
    }
  }
  const create = () => {
    close(false)
    if (!go(props.createOrganizationUrl ?? navigation.createOrganizationUrl, navigation.navigate)) {
      setDialog('create')
    }
  }
  const closeDialog = () => {
    setDialog(null)
    trigger.current?.focus()
  }

  return (
    <div {...el('organizationSwitcher')} ref={container}>
      <button
        type='button'
        {...el('organizationSwitcherTrigger')}
        ref={trigger}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={formatText(
          waiting ? t.organizationSwitcher.triggerInvitation : t.organizationSwitcher.trigger,
          { name }
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{name}</span>
        {waiting ? <span {...el('badge')}>{t.organizationSwitcher.invitationTitle}</span> : null}
        <ChevronIcon />
      </button>
      <span className='tula-visually-hidden'>
        <Status message={said} />
      </span>
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: a labelled group of controls, not a form's fieldset
        <div
          {...el('organizationPanel')}
          id={panelId}
          ref={panel}
          role='group'
          aria-label={t.organizationSwitcher.panelLabel}
        >
          <FormError message={error?.message ?? null} />
          {invitation.status === 'ready' ? (
            <div className='tula-confirmation'>
              <p {...el('sectionTitle')}>{t.organizationSwitcher.invitationTitle}</p>
              <p className='tula-text'>
                {formatText(t.organizationSwitcher.invitationText, {
                  organization: invitation.preview.organizationName,
                  role: invitation.preview.role,
                })}
              </p>
              <div className='tula-button-row tula-is-compact'>
                <Button
                  pending={pending === 'invitation:accepted'}
                  disabled={pending !== null}
                  onClick={() => void answer('accepted')}
                >
                  {t.organizationSwitcher.invitationAccept}
                </Button>
                <Button
                  kind='secondary'
                  pending={pending === 'invitation:declined'}
                  disabled={pending !== null}
                  onClick={() => void answer('declined')}
                >
                  {t.organizationSwitcher.invitationDecline}
                </Button>
              </div>
            </div>
          ) : null}
          {invitation.status === 'failed' ? <FormError message={invitation.error.message} /> : null}
          {organizations === null ? (
            list.error ? (
              <>
                <FormError message={list.error.message || t.organizations.loadFailed} />
                <Button kind='secondary' onClick={() => void list.reload()}>
                  {t.organizations.retry}
                </Button>
              </>
            ) : (
              <p className='tula-text'>{t.organizations.loading}</p>
            )
          ) : (
            <>
              <p {...el('sectionTitle')}>{t.organizationSwitcher.listTitle}</p>
              <ul {...el('organizationList')}>
                {personal ? (
                  <li>
                    <OrganizationItem
                      label={t.organizations.personalAccount}
                      active={list.activeOrganizationId === null}
                      onClick={() => void choose(null)}
                    />
                  </li>
                ) : null}
                {organizations.map((entry) => (
                  <li key={entry.id}>
                    <OrganizationItem
                      label={entry.name}
                      active={entry.id === list.activeOrganizationId}
                      onClick={() => void choose(entry)}
                    />
                  </li>
                ))}
              </ul>
              {organizations.length === 0 ? (
                <p className='tula-text'>{t.organizations.empty}</p>
              ) : null}
              {(suggestions ?? []).length > 0 ? (
                <>
                  <p {...el('sectionTitle')}>{t.organizationSwitcher.suggestionsTitle}</p>
                  <ul {...el('organizationList')}>
                    {(suggestions ?? []).map((entry) => (
                      <li key={entry.id} {...el('memberItem')}>
                        <span>{entry.name}</span>
                        <Button
                          kind='secondary'
                          pending={pending === `join:${entry.id}`}
                          disabled={pending !== null}
                          aria-label={formatText(t.organizationSwitcher.suggestionJoinLabel, {
                            name: entry.name,
                          })}
                          onClick={() => void join(entry)}
                        >
                          {t.organizationSwitcher.suggestionJoin}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div className='tula-menu-items'>
                {active ? (
                  <button type='button' {...el('organizationItem')} onClick={manage}>
                    {t.organizationSwitcher.manage}
                  </button>
                ) : null}
                {config?.organizations?.allowUserCreated === true ? (
                  <button type='button' {...el('organizationItem')} onClick={create}>
                    {t.organizationSwitcher.create}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
      {dialog !== null ? (
        <dialog
          {...el('dialog')}
          ref={dialogElement}
          aria-label={
            dialog === 'profile' ? t.organizationProfile.title : t.createOrganization.title
          }
          onClose={closeDialog}
        >
          <button
            type='button'
            className='tula-dialog-close'
            aria-label={t.organizationSwitcher.close}
            onClick={() => dialogElement.current?.close()}
          >
            <CloseIcon />
          </button>
          {dialog === 'profile' ? (
            <OrganizationProfileSections organizationId={active?.id} />
          ) : (
            <CreateOrganizationForm
              onCancel={() => dialogElement.current?.close()}
              onCreated={(created) => {
                setSaid(formatText(t.organizations.created, { name: created.name }))
                dialogElement.current?.close()
                if (
                  client.state.status === 'signed-in' &&
                  client.state.organizationId === created.id
                ) {
                  props.onSwitch?.(created.id)
                }
              }}
            />
          )}
        </dialog>
      ) : null}
    </div>
  )
}

/** One choice in the list: the name, and a check and "current" for the one in use. */
function OrganizationItem(props: { label: string; active: boolean; onClick(): void }) {
  const { el, t } = useUi()
  return (
    <button
      type='button'
      {...el('organizationItem')}
      aria-current={props.active ? 'true' : undefined}
      onClick={props.onClick}
    >
      {props.label}
      {props.active ? (
        <>
          {' '}
          <CheckIcon />
          <span className='tula-visually-hidden'> ({t.organizationSwitcher.current})</span>
        </>
      ) : null}
    </button>
  )
}

/**
 * The organization the session acts in, and a panel to change it: the user's organizations,
 * "Personal account" where the environment allows it, the organizations their verified email
 * address may join, an invitation the app handed over (`invitationToken`), "Manage
 * organization" and "Create organization". Renders nothing while signed out and where the
 * environment has organizations off.
 *
 * The panel is a disclosure: the button opens it and moves the focus into it, Escape closes it
 * and returns the focus, and so does a click or a focus move outside. A switch is announced
 * politely, and an error stays in the panel, which stays open. "Manage organization" opens
 * `<OrganizationProfile>` and "Create organization" opens `<CreateOrganization>`, each in a
 * dialog unless the app has a page for it (`organizationProfileUrl`, `createOrganizationUrl`).
 *
 * @param props - Callbacks, destinations and appearance; all optional.
 * @returns The component.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * <header>
 *   <SignedIn>
 *     <OrganizationSwitcher onSwitch={() => router.refresh()} />
 *     <UserButton afterSignOutUrl='/' />
 *   </SignedIn>
 * </header>
 * ```
 */
export function OrganizationSwitcher(props: OrganizationSwitcherProps) {
  return (
    <Root appearance={props.appearance} headingLevel={2}>
      <OrganizationSwitcherParts {...props} />
    </Root>
  )
}
