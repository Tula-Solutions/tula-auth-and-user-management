import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { useUser } from '../hooks/use-user'
import { formatText } from '../localization'
import { go } from '../navigation'
import { CloseIcon } from './icons'
import { Root, useUi } from './ui'
import { fullName, initials } from './user-display'
import { UserProfileSections } from './user-profile'

/**
 * Props of {@link UserButton}.
 *
 * @example
 * ```tsx
 * <UserButton afterSignOutUrl='/' />
 * ```
 */
export interface UserButtonProps {
  /** Where to go after "Sign out". Overrides the provider's `afterSignOutUrl`. */
  afterSignOutUrl?: string
  /**
   * Where `<UserProfile>` lives. With it (or the provider's), "Manage account" goes there;
   * without, it opens the profile in a dialog.
   */
  userProfileUrl?: string
  /** Called for "Manage account" instead of either of the above. */
  onManageAccount?: () => void
  /** Theme tokens, colour scheme and class names for this component. */
  appearance?: Appearance
}

function UserButtonParts(props: UserButtonProps) {
  const { el, t } = useUi()
  const { client, navigation } = useTulaContext()
  const { user } = useUser()
  const [open, setOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const menuId = useId()

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) {
      trigger.current?.focus()
    }
  }

  // Opening the menu moves focus to its first item, by mouse and by keyboard alike.
  useEffect(() => {
    if (open) {
      menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    }
  }, [open])

  // A click or a focus move anywhere outside closes the menu.
  useEffect(() => {
    if (!open) {
      return
    }
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [open])

  useEffect(() => {
    const element = dialog.current
    if (!profileOpen || !element) {
      return
    }
    // A modal `<dialog>` traps focus, closes on Escape and dims the page natively.
    if (typeof element.showModal === 'function' && !element.open) {
      element.showModal()
    }
  }, [profileOpen])

  if (!user) {
    return null
  }
  const name = fullName(user) ?? user.email

  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
    }
  }
  const onMenuKey = (event: KeyboardEvent) => {
    const all = items()
    const index = all.indexOf(document.activeElement as HTMLElement)
    const focus = (target: number) => all[(target + all.length) % all.length]?.focus()
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focus(index + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focus(index - 1)
        break
      case 'Home':
        event.preventDefault()
        focus(0)
        break
      case 'End':
        event.preventDefault()
        focus(all.length - 1)
        break
      case 'Escape':
        event.preventDefault()
        close(true)
        break
      case 'Tab':
        // Focus moves on as usual; the menu just closes behind it.
        setOpen(false)
        break
      default:
    }
  }

  const manageAccount = () => {
    const url = props.userProfileUrl ?? navigation.userProfileUrl
    close(true)
    if (props.onManageAccount) {
      props.onManageAccount()
    } else if (!go(url, navigation.navigate)) {
      setProfileOpen(true)
    }
  }
  const signOut = async () => {
    close(true)
    // If the server cannot be told, the client is signed out all the same; go on.
    await client.session.signOut().catch(() => undefined)
    go(props.afterSignOutUrl ?? navigation.afterSignOutUrl, navigation.navigate)
  }
  const closeProfile = () => {
    setProfileOpen(false)
    trigger.current?.focus()
  }

  return (
    <div {...el('userButton')} ref={container}>
      <button
        type='button'
        {...el('userButtonTrigger')}
        ref={trigger}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={formatText(t.userButton.trigger, { name })}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKey}
      >
        <span {...el('avatar')} aria-hidden='true'>
          {initials(user)}
        </span>
      </button>
      {open ? (
        <div {...el('menu')}>
          <div {...el('menuHeader')}>
            <span {...el('avatar')} aria-hidden='true'>
              {initials(user)}
            </span>
            <div className='tula-profile-text'>
              {fullName(user) ? <p className='tula-profile-name'>{fullName(user)}</p> : null}
              <p className='tula-profile-email'>{user.email}</p>
            </div>
          </div>
          <div
            className='tula-menu-items'
            role='menu'
            id={menuId}
            ref={menu}
            aria-label={formatText(t.userButton.trigger, { name })}
            onKeyDown={onMenuKey}
          >
            <button
              type='button'
              role='menuitem'
              tabIndex={-1}
              {...el('menuItem')}
              onClick={manageAccount}
            >
              {t.userButton.manageAccount}
            </button>
            <button
              type='button'
              role='menuitem'
              tabIndex={-1}
              {...el('menuItem')}
              onClick={signOut}
            >
              {t.userButton.signOut}
            </button>
          </div>
        </div>
      ) : null}
      {profileOpen ? (
        <dialog
          {...el('dialog')}
          ref={dialog}
          aria-label={t.userProfile.title}
          onClose={closeProfile}
        >
          <button
            type='button'
            className='tula-dialog-close'
            aria-label={t.userButton.close}
            onClick={() => dialog.current?.close()}
          >
            <CloseIcon />
          </button>
          <UserProfileSections afterSignOutUrl={props.afterSignOutUrl} />
        </dialog>
      ) : null}
    </div>
  )
}

/**
 * The signed-in user's avatar with a menu: manage the account, sign out. Renders nothing while
 * signed out.
 *
 * The menu follows the menu-button pattern: Enter, Space or the arrow keys open it and focus
 * its first item; the arrow keys, Home and End move; Escape closes it and returns focus to the
 * button. "Manage account" opens `<UserProfile>` in a dialog unless the app has a profile page
 * (`userProfileUrl`) or handles it itself (`onManageAccount`).
 *
 * @param props - URLs, a callback and appearance; all optional.
 * @returns The component.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * <header>
 *   <SignedIn>
 *     <UserButton afterSignOutUrl='/' />
 *   </SignedIn>
 * </header>
 * ```
 */
export function UserButton(props: UserButtonProps) {
  return (
    <Root appearance={props.appearance} headingLevel={2}>
      <UserButtonParts {...props} />
    </Root>
  )
}
