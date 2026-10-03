import type { ReactNode } from 'react'

// The few icons the components need, inline, so the package ships no icon library. Each is
// decorative: the text next to it (or the button's label) carries the meaning.

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className='tula-icon'
      viewBox='0 0 20 20'
      width='1em'
      height='1em'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.75'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      focusable='false'
    >
      {children}
    </svg>
  )
}

/** A check mark: a met rule. */
export function CheckIcon() {
  return (
    <Icon>
      <path d='M4.5 10.5l3.5 3.5 7.5-8' />
    </Icon>
  )
}

/** An empty circle: an unmet rule. */
export function CircleIcon() {
  return (
    <Icon>
      <circle cx='10' cy='10' r='6' />
    </Icon>
  )
}

/** An eye: show the password. */
export function EyeIcon() {
  return (
    <Icon>
      <path d='M1.75 10S4.75 4.5 10 4.5 18.25 10 18.25 10 15.25 15.5 10 15.5 1.75 10 1.75 10z' />
      <circle cx='10' cy='10' r='2.5' />
    </Icon>
  )
}

/** A crossed-out eye: hide the password. */
export function EyeOffIcon() {
  return (
    <Icon>
      <path d='M3 3l14 14' />
      <path d='M8.2 5a8 8 0 0 1 1.8-.2c5.25 0 8.25 5.2 8.25 5.2a13.6 13.6 0 0 1-2.3 2.9M12.6 14.9a8 8 0 0 1-2.6.4C4.75 15.3 1.75 10 1.75 10a13.5 13.5 0 0 1 3.4-3.8' />
    </Icon>
  )
}

/** A padlock: the "secured by" line. */
export function LockIcon() {
  return (
    <Icon>
      <rect x='4.5' y='9' width='11' height='8' rx='2' />
      <path d='M7 9V6.5a3 3 0 0 1 6 0V9' />
    </Icon>
  )
}

/** A cross: close a dialog. */
export function CloseIcon() {
  return (
    <Icon>
      <path d='M5 5l10 10M15 5L5 15' />
    </Icon>
  )
}
