import { renderToString } from 'react-dom/server'
import {
  EmailLinkCallback,
  firstFactorStrategies,
  formatDuration,
  formatText,
  OAuthCallback,
  SignedIn,
  SignedOut,
  SignIn,
  SignUp,
  StepRenderer,
  TulaLoading,
  TulaProvider,
  UserButton,
  UserProfile,
  useCountdown,
  useFieldErrors,
  useLocalization,
  usePasskeySupport,
  useRetryCountdown,
  useScreenChanged,
} from '../index'

/** The headless hooks a copied component uses, drawn as text so the output shows them. */
function HeadlessProbe() {
  const t = useLocalization()
  const support = usePasskeySupport()
  const placed = useFieldErrors(null, ['email'])
  const seconds = useCountdown(null) + useRetryCountdown(null)
  const changed = useScreenChanged('a')
  const strategies = firstFactorStrategies(
    ['password'],
    { password: () => null },
    {
      link: false,
      passkey: support,
      phone: false,
    }
  )
  return (
    <p>{`${t.signIn.title}|passkey:${support}|form:${placed.form}|wait:${seconds}|changed:${changed}|strategies:${strategies}|retry:${formatText(t.common.retryIn, { time: formatDuration(65, t) })}`}</p>
  )
}

// Run by `package.test.tsx` in a process of its own, with plain `bun run`: no test preload, so
// no DOM. It renders every component the way a server does and prints the HTML. A component
// that touched `window` or `document` while rendering would throw here.
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
  throw new Error('ssr-render: expected no DOM globals')
}

const html = renderToString(
  <TulaProvider
    publishableKey='tula_pk_dev_unit00000000000000000000000000'
    baseUrl='https://auth.test'
    signInUrl='/sign-in'
    appearance={{ theme: { light: { primary: '#0f766e' } } }}
  >
    <TulaLoading>
      <p>loading</p>
    </TulaLoading>
    <SignedIn>
      <p>in</p>
    </SignedIn>
    <SignedOut>
      <p>out</p>
    </SignedOut>
    <SignIn
      signUpUrl='/sign-up'
      afterSignInUrl='/app'
      emailLinkUrl='/auth/link'
      oauthCallbackUrl='/oauth/callback'
    />
    <EmailLinkCallback />
    <OAuthCallback />
    <SignUp />
    <UserButton />
    <UserProfile />
    <HeadlessProbe />
    <StepRenderer
      step={{ status: 'needs_password' }}
      screens={{ needs_password: () => <p>copied password screen</p> }}
      onRestart={() => undefined}
    />
    <StepRenderer
      step={{ status: 'needs_teleport' } as never}
      screens={{}}
      onRestart={() => undefined}
    />
  </TulaProvider>
)
process.stdout.write(html)
