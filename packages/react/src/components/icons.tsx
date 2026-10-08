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

/** A key: a passkey. */
export function KeyIcon() {
  return (
    <Icon>
      <circle cx='7' cy='13' r='3.25' />
      <path d='M9.5 10.5l6.5-6.5M13.5 6.5l2 2M11.5 8.5l1.5 1.5' />
    </Icon>
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

/**
 * A provider's mark, beside the provider's name on a "Continue with …" button. Decorative: the
 * button's text names the provider.
 */
function Mark({ viewBox, children }: { viewBox: string; children: ReactNode }) {
  return (
    <svg viewBox={viewBox} width='18' height='18' aria-hidden='true' focusable='false'>
      {children}
    </svg>
  )
}

/**
 * Google's "G", in the four colours its branding guidelines require on a neutral button. The
 * colours are the mark's own, which is why they are not theme tokens.
 */
export function GoogleMark() {
  return (
    <Mark viewBox='0 0 18 18'>
      <path
        fill='#4285F4'
        d='M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z'
      />
      <path
        fill='#34A853'
        d='M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z'
      />
      <path
        fill='#FBBC05'
        d='M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z'
      />
      <path
        fill='#EA4335'
        d='M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z'
      />
    </Mark>
  )
}

/** GitHub's mark, in the button's text colour (black on light, white on dark, as GitHub asks). */
export function GitHubMark() {
  return (
    <Mark viewBox='0 0 16 16'>
      <path
        fill='currentColor'
        fillRule='evenodd'
        d='M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z'
      />
    </Mark>
  )
}

/** Apple's logo, in the button's text colour (black on light, white on dark, as Apple asks). */
export function AppleMark() {
  return (
    <Mark viewBox='0 0 24 24'>
      <path
        fill='currentColor'
        d='M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'
      />
    </Mark>
  )
}
