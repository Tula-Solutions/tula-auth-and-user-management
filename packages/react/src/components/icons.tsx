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

/**
 * Microsoft's logo: four squares in the colours its branding guidelines give, which are the
 * mark's own and so not theme tokens (as Google's are not). Drawn here, never fetched.
 */
export function MicrosoftMark() {
  return (
    <Mark viewBox='0 0 21 21'>
      <path fill='#F25022' d='M0 0h10v10H0z' />
      <path fill='#7FBA00' d='M11 0h10v10H11z' />
      <path fill='#00A4EF' d='M0 11h10v10H0z' />
      <path fill='#FFB900' d='M11 11h10v10H11z' />
    </Mark>
  )
}

/**
 * Discord's mark (the controller-shaped face) in its "blurple", the mark's own colour and so
 * not a theme token (as Google's are not). Drawn here, never fetched.
 */
export function DiscordMark() {
  return (
    <Mark viewBox='0 0 24 24'>
      <path
        fill='#5865F2'
        d='M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.099.246.198.373.292a.077.077 0 0 1-.007.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.095 2.157 2.419 0 1.333-.956 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.095 2.157 2.419 0 1.333-.946 2.419-2.157 2.419z'
      />
    </Mark>
  )
}

/**
 * LinkedIn's mark (the "in" in a rounded square) in its blue, the mark's own colour and so
 * not a theme token (as Google's are not). Drawn here, never fetched.
 */
export function LinkedInMark() {
  return (
    <Mark viewBox='0 0 24 24'>
      <path
        fill='#0A66C2'
        d='M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z'
      />
    </Mark>
  )
}

/**
 * X's mark, in the button's text colour (black on light, white on dark). Drawn here, never
 * fetched. Not checked against X's brand page: see `<OAuthButtons>`.
 */
export function XMark() {
  return (
    <Mark viewBox='0 0 24 24'>
      <path
        fill='currentColor'
        d='M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'
      />
    </Mark>
  )
}

/**
 * Facebook's mark (the "f" in a circle) in its blue, the mark's own colour and so not a
 * theme token (as Google's are not). Drawn here, never fetched. Not checked against Meta's
 * brand page: see `<OAuthButtons>`.
 */
export function FacebookMark() {
  return (
    <Mark viewBox='0 0 24 24'>
      <path
        fill='#0866FF'
        d='M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z'
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
