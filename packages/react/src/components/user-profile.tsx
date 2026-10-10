import {
  type Factors,
  isStepUpRequired,
  type Session,
  type TotpEnrolment,
  type TulaError,
  type User,
} from '@tula/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from '../hooks/use-auth-state'
import { useClientConfig, usePasswordChecklist } from '../hooks/use-password-checklist'
import { useSession } from '../hooks/use-session'
import { useStepUp } from '../hooks/use-step-up'
import { useUser } from '../hooks/use-user'
import { formatText } from '../localization'
import { useRetryAfter } from './flow-screens'
import { fieldResolver, formatDuration, placeErrors } from './form-errors'
import { BackupCodesPanel, EnrolmentConfirmForm, TextedCodeForm } from './mfa'
import { ConnectedAccountsSection } from './oauth'
import { PasskeysSection, type SecondStepRead } from './passkey'
import { PhoneSection } from './phone'
import {
  Button,
  Form,
  FormError,
  Heading,
  type HeadingLevel,
  PasswordField,
  passwordHistoryRule,
  Root,
  Status,
  useUi,
} from './ui'
import { deviceName, fullName, initials, relativeTime } from './user-display'

/**
 * Props of {@link UserProfile}.
 *
 * @example
 * ```tsx
 * <UserProfile afterSignOutUrl='/' />
 * ```
 */
export interface UserProfileProps {
  /** Where to go after "Sign out". Overrides the provider's `afterSignOutUrl`. */
  afterSignOutUrl?: string
  /**
   * The page an OAuth round trip returns to: the one that renders `<OAuthCallback>`. Overrides
   * the provider's `oauthCallbackUrl`; without either, "Connected accounts" offers no provider
   * to connect.
   */
  oauthCallbackUrl?: string
  /** Theme tokens, colour scheme and class names for this component. */
  appearance?: Appearance
  /** The level of the "Account" title; section titles are one below. Defaults to 1. */
  headingLevel?: HeadingLevel
}

function ProfileSection(props: { user: User }) {
  const { el, t } = useUi()
  const { user } = props
  const titleId = useId()
  const name = fullName(user)
  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.userProfile.profileTitle}
      </Heading>
      <div {...el('profile')}>
        <span {...el('avatar')} aria-hidden='true'>
          {initials(user)}
        </span>
        <div className='tula-profile-text'>
          {name ? <p className='tula-profile-name'>{name}</p> : null}
          {/* No address (an account made through X or Facebook): no line, and no badge
              that would call an address nobody gave "not verified". */}
          {user.email === null ? null : (
            <p className='tula-profile-email'>
              <span>{user.email}</span>{' '}
              <span {...el('badge', user.emailVerifiedAt ? 'tula-is-positive' : undefined)}>
                {user.emailVerifiedAt ? t.userProfile.emailVerified : t.userProfile.emailUnverified}
              </span>
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * The password section of a user who has none (`hasPassword: false`): there is no current
 * password to ask for, so it says how one is added (a password reset from the sign-in screen
 * creates the first password) instead of drawing a form that could only fail. Only an explicit
 * `false` gets this: an older server that does not say keeps the form.
 */
function NoPasswordSection() {
  const { el, t } = useUi()
  const titleId = useId()
  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.userProfile.passwordTitle}
      </Heading>
      <p className='tula-text'>
        {formatText(t.userProfile.passwordNotSet, { forgotPassword: t.signIn.forgotPassword })}
      </p>
    </section>
  )
}

/**
 * The password section a user gets. None at all for an account with no email address (one
 * made through X or Facebook): a password signs in beside an address, the server refuses
 * one for such an account, and "Forgot password?" would have nowhere to send its email.
 */
function passwordSection(user: User, sessionId: string | null, onChanged: () => void) {
  if (user.email === null) {
    return null
  }
  if (user.hasPassword === false) {
    return <NoPasswordSection />
  }
  // Keyed by the session: half-typed passwords, a pending change and its messages belong to
  // whoever was signed in when they began, and go with them.
  return <PasswordSection key={sessionId} user={user} email={user.email} onChanged={onChanged} />
}

function PasswordSection(props: { user: User; email: string; onChanged(): void }) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const withStepUp = useStepUp()
  const { user } = props
  const titleId = useId()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<TulaError | null>(null)
  const [local, setLocal] = useState<{ currentPassword?: string; newPassword?: string } | null>(
    null
  )
  const [changed, setChanged] = useState(false)
  // Whether the new password was retyped since the last answer: a refusal is about what was sent.
  const [edited, setEdited] = useState(false)
  const checklist = usePasswordChecklist(newPassword, {
    email: props.email,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
  })
  const limits = useRetryAfter<'change'>(error)
  const wait = limits.secondsLeft('change')
  // The API names the new password's field `newPassword`; a rule's own code says `password.*`.
  const byName = fieldResolver(['currentPassword', 'newPassword'], 'currentPassword')
  const placed = placeErrors(
    error,
    (code, field) =>
      byName(code, field) ??
      (code.startsWith('password.') && code !== 'password.not_set' ? 'newPassword' : null)
  )
  if (error?.code === 'auth.invalid_credentials') {
    // The API's message for this code is written for sign-in ("email or password"). Here the
    // user is signed in and only one thing can be wrong, so say which.
    placed.fields.currentPassword = [t.userProfile.currentPasswordWrong]
  }
  const errorsOf = (field: 'currentPassword' | 'newPassword') =>
    local?.[field] ? [local[field]] : local ? [] : placed.fields[field]

  const submit = async () => {
    setChanged(false)
    const problems = {
      ...(currentPassword === '' && { currentPassword: t.common.required }),
      ...(newPassword === '' && { newPassword: t.common.required }),
    }
    if (Object.keys(problems).length > 0) {
      setLocal(problems)
      return
    }
    setLocal(null)
    setError(null)
    setEdited(false)
    setPending(true)
    limits.mark('change')
    try {
      // A user with two-step verification is asked for it first, when the server says so.
      await withStepUp(() => client.user.changePassword({ currentPassword, newPassword }))
      setCurrentPassword('')
      setNewPassword('')
      setChanged(true)
      props.onChanged()
    } catch (caught) {
      if (isStepUpRequired(caught)) {
        // The user closed the step-up dialog: nothing was changed and nothing went wrong.
        return
      }
      const failure = toTulaError(caught)
      if (failure.code === 'auth.invalid_credentials') {
        // A wrong password is retyped from scratch, as at sign-in.
        setCurrentPassword('')
      }
      setError(failure)
    } finally {
      setPending(false)
    }
  }

  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.userProfile.passwordTitle}
      </Heading>
      <Form onSubmit={submit} failure={local ?? error} blocked={pending || wait > 0}>
        <FormError
          message={placed.form}
          detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
        />
        <input
          className='tula-visually-hidden'
          type='text'
          name='username'
          autoComplete='username'
          value={props.email}
          readOnly
          tabIndex={-1}
          aria-hidden='true'
        />
        <PasswordField
          label={t.userProfile.currentPasswordLabel}
          name='current-password'
          autoComplete='current-password'
          value={currentPassword}
          onValue={(value) => {
            setCurrentPassword(value)
            setLocal(null)
          }}
          errors={errorsOf('currentPassword')}
          required
        />
        <PasswordField
          label={t.userProfile.newPasswordLabel}
          name='new-password'
          autoComplete='new-password'
          value={newPassword}
          onValue={(value) => {
            setNewPassword(value)
            setLocal(null)
            setEdited(true)
          }}
          errors={errorsOf('newPassword')}
          checks={checklist.checks}
          history={passwordHistoryRule(checklist.policy, error, edited)}
          required
        />
        <Button type='submit' kind='secondary' pending={pending} disabled={wait > 0}>
          {t.userProfile.changePassword}
        </Button>
        <Status message={changed ? t.userProfile.passwordChanged : null} />
      </Form>
    </section>
  )
}

/**
 * "Two-step verification": turn it on (QR code, setup key, a code to confirm), see the backup
 * codes once, make new ones, turn it off. Sensitive calls go through `useStepUp`, so the
 * provider's dialog appears when the server asks for one. The secret and the codes live in
 * this section's state only while their screen is shown.
 *
 * A code by text message (ADR 0025) is offered only where the server says this user could
 * enrol it (`factors.sms.available`: the app has it on, the account has a proven number and
 * nothing stronger), and the message is sent only when the user asks for it.
 */
function TwoStepSection(props: {
  phoneNumber: string | null
  /** Changes when something outside this section changed what the server would answer. */
  revision: number
  onChanged(): void
  /** Told what is known of the second step in use, from the first render on. */
  onSecondStep(read: SecondStepRead): void
}) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const config = useClientConfig()
  const policy = config?.mfa?.policy
  const withStepUp = useStepUp()
  const titleId = useId()
  const [factors, setFactors] = useState<Factors | null>(null)
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  /** The masked number the enrolment's code was texted to, while its form is open. */
  const [texted, setTexted] = useState<string | null>(null)
  const [busy, setBusy] = useState<
    'on' | 'confirm' | 'off' | 'codes' | 'sms' | 'smsConfirm' | 'smsOff' | null
  >(null)
  const [error, setError] = useState<TulaError | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Whether the last read of the factors failed. */
  const [unread, setUnread] = useState(false)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const next = await client.mfa.get()
      if (mounted.current) {
        setFactors(next)
        setUnread(false)
      }
    } catch (caught) {
      if (mounted.current) {
        setError(toTulaError(caught))
        setUnread(true)
      }
    }
  }, [client])
  useEffect(() => {
    mounted.current = true
    // Asked only once the app is known to offer (or to have offered) two-step verification.
    if (policy !== undefined) {
      void load()
    }
    return () => {
      mounted.current = false
    }
  }, [load, policy])
  // Whether a texted code can be the second step, and whether it still is one, follows the
  // account's phone number (added, replaced or removed in the section above) and its
  // passkeys (one added sets a texted code aside, the last one removed brings it back).
  // Read again rather than guessed from either.
  const loadedFor = useRef({ phoneNumber: props.phoneNumber, revision: props.revision })
  useEffect(() => {
    const seen = loadedFor.current
    if (seen.phoneNumber !== props.phoneNumber || seen.revision !== props.revision) {
      loadedFor.current = { phoneNumber: props.phoneNumber, revision: props.revision }
      if (policy !== undefined) {
        void load()
      }
    }
  }, [props.phoneNumber, props.revision, policy, load])
  // What the passkeys section may act on. Factors that were read once stay what is known
  // when a later read fails; a configuration that names no two-step verification is an app
  // without any, so there is nothing to read and nothing a passkey could replace.
  const secondStep: SecondStepRead =
    factors !== null
      ? factors.sms?.inUse === true
        ? 'texted_code'
        : 'other'
      : unread
        ? 'unchecked'
        : config !== null && policy === undefined
          ? 'other'
          : 'checking'
  const { onSecondStep } = props
  useEffect(() => {
    onSecondStep(secondStep)
  }, [secondStep, onSecondStep])

  /** Run one action; a step-up the user declined is their choice, not an error to show. */
  const run = async (name: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    setMessage(null)
    try {
      await work()
      return true
    } catch (caught) {
      if (mounted.current && !isStepUpRequired(caught)) {
        setError(toTulaError(caught))
      }
      return false
    } finally {
      if (mounted.current) {
        setBusy(null)
      }
    }
  }
  const turnOn = () =>
    run('on', async () => {
      const started = await withStepUp(() => client.mfa.startTotp())
      if (mounted.current) {
        setEnrolment(started)
      }
    })
  const confirm = (code: string) =>
    run('confirm', async () => {
      const result = await client.mfa.confirmTotp({ code })
      if (mounted.current) {
        setEnrolment(null)
        setCodes(result.codes)
      }
    })
  const regenerate = () =>
    run('codes', async () => {
      const result = await withStepUp(() => client.mfa.regenerateBackupCodes())
      if (mounted.current) {
        setCodes(result.codes)
      }
    })
  const turnOff = () =>
    run('off', async () => {
      await withStepUp(() => client.mfa.disableTotp())
      await load()
      if (mounted.current) {
        setMessage(t.mfa.turnedOff)
      }
    })
  const textCode = () =>
    run('sms', async () => {
      const sent = await withStepUp(() => client.mfa.startSms())
      if (mounted.current) {
        setTexted(sent.destination)
      }
    })
  const confirmSms = (code: string) =>
    run('smsConfirm', async () => {
      const next = await client.mfa.confirmSms({ code })
      if (mounted.current) {
        setTexted(null)
        setFactors(next)
        setMessage(t.mfa.smsTurnedOn)
      }
      // Turning it on ended the user's other sessions.
      props.onChanged()
    })
  const stopSms = () =>
    run('smsOff', async () => {
      await withStepUp(() => client.mfa.disableSms())
      await load()
      if (mounted.current) {
        setMessage(t.mfa.smsTurnedOff)
      }
    })
  const codesSaved = async () => {
    const wasOn = factors?.totp.enabled === true
    setCodes(null)
    await load()
    if (mounted.current) {
      setMessage(wasOn ? t.mfa.regenerated : t.mfa.turnedOn)
    }
    // Turning it on ended the user's other sessions.
    props.onChanged()
  }

  const enabled = factors?.totp.enabled === true
  const sms = factors?.sms
  const smsOn = sms?.enabled === true
  if (
    policy === undefined ||
    (policy === 'off' && factors !== null && !enabled && !smsOn && !codes)
  ) {
    // Not offered by this app (or not known yet): there is nothing to show.
    return null
  }
  const remaining = factors?.backupCodes.remaining ?? 0
  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.mfa.sectionTitle}
      </Heading>
      {codes ? (
        <>
          <p className='tula-profile-name'>{t.mfa.backupCodesTitle}</p>
          <BackupCodesPanel codes={codes} onDone={codesSaved} />
        </>
      ) : enrolment ? (
        <EnrolmentConfirmForm
          enrolment={enrolment}
          isPending={busy === 'confirm'}
          error={error}
          confirm={confirm}
          onCancel={() => {
            setEnrolment(null)
            setError(null)
          }}
        />
      ) : texted !== null ? (
        <>
          <TextedCodeForm
            destination={texted}
            isPending={busy === 'smsConfirm'}
            error={error}
            prompt={t.mfa.smsSubtitle}
            submitLabel={t.mfa.confirmSubmit}
            send={textCode}
            submit={confirmSms}
          />
          <Button
            kind='link'
            onClick={() => {
              setTexted(null)
              setError(null)
            }}
          >
            {t.mfa.cancel}
          </Button>
        </>
      ) : (
        <>
          <FormError message={error?.message ?? null} />
          {smsOn && sms ? (
            <>
              <p className='tula-text'>
                <span {...el('badge', 'tula-is-positive')}>
                  {formatText(t.mfa.smsStatusOn, {
                    date: new Date(sms.enabledAt ?? 0).toLocaleDateString(t.locale, {
                      dateStyle: 'medium',
                    }),
                  })}
                </span>
                {sms.inUse ? null : ` ${t.mfa.smsNotInUse}`}
              </p>
              {policy === 'required' && sms.inUse ? (
                <p {...el('hint')}>{t.mfa.requiredByApp}</p>
              ) : (
                <div className='tula-button-row tula-is-compact'>
                  <Button kind='danger' pending={busy === 'smsOff'} onClick={stopSms}>
                    {t.mfa.smsTurnOff}
                  </Button>
                </div>
              )}
            </>
          ) : null}
          {factors === null ? (
            <p className='tula-text'>{error ? null : t.mfa.statusLoading}</p>
          ) : enabled ? (
            <>
              <p className='tula-text'>
                <span {...el('badge', 'tula-is-positive')}>
                  {formatText(t.mfa.statusOn, {
                    date: new Date(factors.totp.confirmedAt ?? 0).toLocaleDateString(t.locale, {
                      dateStyle: 'medium',
                    }),
                  })}
                </span>{' '}
                {remaining === 1
                  ? t.mfa.codesRemainingOne
                  : formatText(t.mfa.codesRemaining, { count: remaining })}
              </p>
              <div className='tula-button-row tula-is-compact'>
                <Button kind='secondary' pending={busy === 'codes'} onClick={regenerate}>
                  {t.mfa.regenerate}
                </Button>
                {policy === 'required' ? null : (
                  <Button kind='danger' pending={busy === 'off'} onClick={turnOff}>
                    {t.mfa.turnOff}
                  </Button>
                )}
              </div>
              {policy === 'required' ? <p {...el('hint')}>{t.mfa.requiredByApp}</p> : null}
            </>
          ) : smsOn ? (
            <>
              <p className='tula-text'>{t.mfa.smsWeaker}</p>
              <Button kind='secondary' pending={busy === 'on'} onClick={turnOn}>
                {t.mfa.enrolStart}
              </Button>
            </>
          ) : (
            <>
              <p className='tula-text'>{t.mfa.statusOff}</p>
              <Button kind='secondary' pending={busy === 'on'} onClick={turnOn}>
                {t.mfa.turnOn}
              </Button>
            </>
          )}
          {!smsOn && sms?.available ? (
            <>
              <p className='tula-text'>{t.mfa.smsOffer}</p>
              <Button kind='secondary' pending={busy === 'sms'} onClick={textCode}>
                {t.mfa.smsTurnOn}
              </Button>
            </>
          ) : null}
          <Status message={message} />
        </>
      )}
    </section>
  )
}

function SessionRow(props: { session: Session; busy: boolean; onRevoke(): void }) {
  const { el, t } = useUi()
  const { session } = props
  const device = deviceName(session, t)
  return (
    <li {...el('sessionItem')} data-current={session.current || undefined}>
      <div className='tula-session-text'>
        <p className='tula-session-device'>
          <span>{device}</span>{' '}
          {session.current ? <span {...el('badge')}>{t.userProfile.thisDevice}</span> : null}
          {/* In words, like "This device": never a colour or an icon alone. */}
          {session.deviceBound ? (
            <>
              {session.current ? ' ' : null}
              <span {...el('badge')}>{t.userProfile.deviceBound}</span>
            </>
          ) : null}
        </p>
        <p className={session.current ? 'tula-session-meta tula-is-positive' : 'tula-session-meta'}>
          {session.current
            ? t.userProfile.activeNow
            : formatText(t.userProfile.lastActive, {
                time: relativeTime(session.lastActiveAt, Date.now(), t.locale),
              })}
        </p>
      </div>
      {session.current ? null : (
        <Button
          kind='danger'
          pending={props.busy}
          onClick={props.onRevoke}
          aria-label={formatText(t.userProfile.signOutDeviceLabel, { device })}
        >
          {t.userProfile.signOutDevice}
        </Button>
      )}
    </li>
  )
}

function SessionsSection(props: { sessions: ReturnType<typeof useSession> }) {
  const { el, t } = useUi()
  const { sessions, error, revoke, revokeOthers } = props.sessions
  const titleId = useId()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const others = sessions?.filter((session) => !session.current) ?? []

  const signOutDevice = async (id: string) => {
    setMessage(null)
    setBusy(id)
    const ok = await revoke(id)
    setBusy(null)
    setMessage(ok ? t.userProfile.deviceSignedOut : null)
  }
  const signOutOthers = async () => {
    setMessage(null)
    setBusy('others')
    const count = await revokeOthers()
    setBusy(null)
    setMessage(count === null ? null : formatText(t.userProfile.othersSignedOut, { count }))
  }

  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.userProfile.sessionsTitle}
      </Heading>
      <FormError message={error?.message ?? null} />
      {sessions === null ? (
        <p className='tula-text'>{error ? null : t.userProfile.sessionsLoading}</p>
      ) : (
        <ul {...el('sessionList')}>
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              busy={busy === session.id}
              onRevoke={() => signOutDevice(session.id)}
            />
          ))}
        </ul>
      )}
      {others.length > 0 ? (
        <Button kind='danger' pending={busy === 'others'} onClick={signOutOthers}>
          {t.userProfile.signOutOthers}
        </Button>
      ) : null}
      <Status message={message} />
    </section>
  )
}

/** The profile's sections, without a root: `<UserButton>` puts them in its dialog. */
export function UserProfileSections(props: {
  afterSignOutUrl?: string
  oauthCallbackUrl?: string
}) {
  const { el, t } = useUi()
  const context = useTulaContext()
  const { client, navigation } = context
  const state = useAuthState(client)
  const { user } = useUser()
  const sessions = useSession()
  const titleId = useId()
  const signOutTitleId = useId()
  const [signingOut, setSigningOut] = useState(false)
  // What the two-step section read, for the passkeys section's warning; and a count of the
  // passkey changes, for the two-step section to read again. What was read belongs to the
  // session it was read for: until that session's own section has reported, a passkey
  // cannot be added (`checking`), so one user's answer is never another's.
  const [secondStep, setSecondStep] = useState<{ sessionId: string; read: SecondStepRead } | null>(
    null
  )
  const [passkeyChanges, setPasskeyChanges] = useState(0)
  const sessionId = state.status === 'signed-in' ? state.sessionId : null
  const reportSecondStep = useCallback(
    (read: SecondStepRead) => setSecondStep(sessionId === null ? null : { sessionId, read }),
    [sessionId]
  )

  if (state.status !== 'signed-in') {
    return null
  }
  const signOut = async () => {
    setSigningOut(true)
    // Navigates only once the server was told; a failure is said by the provider, which is
    // still on the page when this profile (drawn for a signed-in user) no longer is.
    await context.signOut(props.afterSignOutUrl)
    setSigningOut(false)
  }
  return (
    <section {...el('card', 'tula-card-wide')} aria-labelledby={titleId}>
      <header {...el('header')}>
        <Heading {...el('title')} id={titleId}>
          {t.userProfile.title}
        </Heading>
      </header>
      {user ? (
        <>
          <ProfileSection user={user} />
          {/* Keyed by the session: half-typed passwords, a pending change and its messages
              belong to whoever was signed in when they began, and go with them. */}
          {passwordSection(user, state.sessionId, () => void sessions.reload())}
          <PhoneSection key={`phone:${state.sessionId}`} user={user} />
        </>
      ) : (
        <p className='tula-text'>{t.common.loading}</p>
      )}
      <TwoStepSection
        key={`mfa:${state.sessionId}`}
        phoneNumber={user?.phoneNumber ?? null}
        revision={passkeyChanges}
        onChanged={() => void sessions.reload()}
        onSecondStep={reportSecondStep}
      />
      <PasskeysSection
        key={`passkeys:${state.sessionId}`}
        secondStep={secondStep?.sessionId === state.sessionId ? secondStep.read : 'checking'}
        onChanged={() => setPasskeyChanges((count) => count + 1)}
      />
      <ConnectedAccountsSection
        key={`identities:${state.sessionId}`}
        callbackUrl={props.oauthCallbackUrl ?? navigation.oauthCallbackUrl}
      />
      <SessionsSection key={state.sessionId} sessions={sessions} />
      <section {...el('section')} aria-labelledby={signOutTitleId}>
        <Heading offset={1} {...el('sectionTitle')} id={signOutTitleId}>
          {t.userProfile.signOutTitle}
        </Heading>
        <Button kind='secondary' pending={signingOut} onClick={signOut}>
          {t.userProfile.signOut}
        </Button>
      </section>
    </section>
  )
}

/**
 * Account management for the signed-in user: who they are, change the password, a phone
 * number (where the app sends text messages: add it with a texted code, remove it), two-step
 * verification, passkeys (where the environment has them on), connected accounts, and where
 * they are signed in, with "this device" marked, one device or all the others signed out, and
 * sign out. Renders nothing while signed out.
 *
 * "Sign out" goes to the after-sign-out URL only once the server has been told. When it could
 * not be, nothing navigates and the provider says, in a dialog with "Try again", that the
 * session may still be active on this device.
 *
 * @param props - The after-sign-out URL and appearance; all optional.
 * @returns The component.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * <SignedIn>
 *   <UserProfile afterSignOutUrl='/' />
 * </SignedIn>
 * ```
 */
export function UserProfile(props: UserProfileProps) {
  return (
    <Root appearance={props.appearance} headingLevel={props.headingLevel}>
      <UserProfileSections
        afterSignOutUrl={props.afterSignOutUrl}
        oauthCallbackUrl={props.oauthCallbackUrl}
      />
    </Root>
  )
}
