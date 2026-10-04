import type { StepUpMethod, StepUpPrepared, StepUpProof, TulaError } from '@tula/core'
import { type ReactNode, type SyntheticEvent, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from '../hooks/use-auth-state'
import { formatText } from '../localization'
import { CODE_LENGTH, CodeField, ResendButton, useRetryAfter } from './flow-screens'
import { attemptsLeft, formatDuration } from './form-errors'
import { BackupCodesPanel, drawableFactors, SecondFactorForm } from './mfa'
import { PasskeyPanel, usePasskeySupport } from './passkey'
import { Button, Form, FormError, Heading, PasswordField, Root, Status, useUi } from './ui'

/**
 * What the provider is asking the user, above whatever the app is showing: to prove who they
 * are before a sensitive change, or to save backup codes that are shown once.
 */
export type Prompt =
  | {
      kind: 'step-up'
      /** What the user can step up with; empty when they can only sign in again. */
      methods: readonly StepUpMethod[]
      /** Called once: `true` when the session was stepped up, `false` when the user gave up. */
      resolve(proven: boolean): void
    }
  | {
      kind: 'backup-codes'
      codes: readonly string[]
      /** Called once the user says they saved the codes. */
      resolve(): void
    }

/**
 * The first element of the page the Tab key would stop at, for a dialog that closes with
 * nothing to give the focus back to. Left on `<body>`, Chromium's next Tab does not reach the
 * page's first control.
 *
 * @returns The element, or `undefined` when the page has none.
 */
function firstTabbable(): HTMLElement | undefined {
  const candidates = document.querySelectorAll<HTMLElement>(
    'a[href],button,input:not([type=hidden]),select,textarea,[tabindex]'
  )
  for (const candidate of candidates) {
    if (
      !(Number(candidate.getAttribute('tabindex')) < 0) &&
      !candidate.matches(':disabled') &&
      !candidate.closest('[hidden],[inert]') &&
      // Not rendered (`display: none`, a closed dialog), where the browser can say.
      candidate.checkVisibility?.() !== false
    ) {
      return candidate
    }
  }
  return undefined
}

/**
 * A modal dialog (`<dialog>` opened with `showModal`, so focus is trapped, the page behind is
 * inert and Escape is announced by the browser). Its title labels it.
 */
function Modal(props: { title: string; onCancel?(): void; children: ReactNode }) {
  const { el } = useUi()
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const element = dialog.current
    // What had the focus when the dialog opened gets it back when it closes. The browser does
    // this for a dialog that is closed; this one is taken out of the page instead.
    const opener = document.activeElement
    if (element && typeof element.showModal === 'function' && !element.open) {
      element.showModal()
    }
    // Open on the field the dialog is for; a dialog with nothing to type opens on its title,
    // so that a screen reader starts from what it says.
    const field = element?.querySelector<HTMLElement>('input:not([type="checkbox"])')
    ;(field ?? title.current)?.focus()
    return () => {
      if (element?.open) {
        element.close()
      }
      // The opener is often gone: the "Sign out" item once the client is signed out, the
      // sign-in form once an enrolment completed (focus is then already on `<body>`).
      const gone =
        !(opener instanceof HTMLElement && opener.isConnected) || opener === document.body
      ;(gone ? firstTabbable() : opener)?.focus()
    }
  }, [])
  const { onCancel } = props
  // Escape asks to cancel; the prompt decides. Backup codes cannot be dismissed unsaved.
  const cancel = (event: SyntheticEvent) => {
    event.preventDefault()
    onCancel?.()
  }
  return (
    <dialog {...el('modal')} ref={dialog} aria-labelledby={titleId} onCancel={cancel}>
      <section {...el('card')}>
        <header {...el('header')}>
          <Heading {...el('title')} id={titleId} headingRef={title}>
            {props.title}
          </Heading>
        </header>
        {props.children}
      </section>
    </dialog>
  )
}

/** The password form of a step-up, for a user without a second factor. */
function PasswordStepUp(props: {
  isPending: boolean
  error: TulaError | null
  submit(proof: StepUpProof): Promise<boolean>
}) {
  const { t } = useUi()
  const { error, isPending } = props
  const [password, setPassword] = useState('')
  const [missing, setMissing] = useState(false)
  const limits = useRetryAfter<'verify'>(error, 'verify')
  const wait = limits.secondsLeft('verify')
  const wrong = error?.code === 'auth.invalid_credentials'
  const submit = async () => {
    if (password === '') {
      setMissing(true)
      return
    }
    limits.mark('verify')
    if (!(await props.submit({ method: 'password', password }))) {
      // A wrong password is retyped from scratch, as at sign-in.
      setPassword('')
    }
  }
  return (
    <Form onSubmit={submit} failure={missing || error} blocked={isPending || wait > 0}>
      <p className='tula-text'>{t.stepUp.passwordSubtitle}</p>
      <FormError
        message={error && !wrong ? error.message : null}
        detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
      />
      <PasswordField
        label={t.stepUp.passwordLabel}
        name='current-password'
        autoComplete='current-password'
        value={password}
        onValue={(value) => {
          setPassword(value)
          setMissing(false)
        }}
        errors={missing ? [t.common.required] : wrong ? [t.stepUp.passwordWrong] : []}
        required
      />
      <Button type='submit' pending={isPending} disabled={wait > 0}>
        {t.stepUp.submit}
      </Button>
    </Form>
  )
}

/**
 * The emailed-code form of a step-up, for a user with no second factor: sends the code when
 * it appears (the user chose it, or it is the only way they have), then takes the code.
 *
 * The send is asked for once per appearance: a ref outlives StrictMode's second run of the
 * effect, so two runs send one email. A form that appears again while the dialog still holds
 * the receipt of its own earlier send (the user looked at the password form and came back)
 * sends nothing: that code can still be typed.
 *
 * The code field is shown only once a send of this dialog succeeded. A refused send, the
 * one-a-minute limit included, says so with the server's wait counted down and offers "Send
 * code" again: the dialog never claims a code it did not send is in the user's inbox.
 */
function EmailCodeStepUp(props: {
  isPending: boolean
  error: TulaError | null
  /** What this dialog's last successful send answered, kept by the dialog. */
  receipt: StepUpPrepared | null
  onReceipt(receipt: StepUpPrepared): void
  submit(proof: StepUpProof): Promise<boolean>
}) {
  const { t } = useUi()
  const { client } = useTulaContext()
  const { isPending, receipt, onReceipt } = props
  const [sendError, setSendError] = useState<TulaError | null>(null)
  const [sending, setSending] = useState(false)
  const [resent, setResent] = useState(false)
  const [code, setCode] = useState('')
  const [incomplete, setIncomplete] = useState(false)
  const [action, setAction] = useState<'send' | 'verify'>('send')
  const error = action === 'send' ? sendError : props.error
  const limits = useRetryAfter<'send' | 'verify'>(error)
  const sendWait = limits.secondsLeft('send')
  const verifyWait = limits.secondsLeft('verify')
  const form = useRef<HTMLDivElement>(null)

  const send = async (again: boolean) => {
    const state = client.state
    const sessionId = state.status === 'signed-in' ? state.sessionId : null
    limits.mark('send')
    setAction('send')
    setSending(true)
    setSendError(null)
    setResent(false)
    setIncomplete(false)
    let answer: StepUpPrepared | null = null
    let failure: TulaError | null = null
    try {
      answer = await client.session.prepareStepUp({ method: 'email_code' })
    } catch (caught) {
      failure = toTulaError(caught)
    }
    // A receipt belongs to the session that asked for it.
    const now = client.state
    if (now.status !== 'signed-in' || now.sessionId !== sessionId) {
      return
    }
    setSending(false)
    setSendError(failure)
    if (answer) {
      onReceipt(answer)
      setResent(again)
    }
  }

  const asked = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: sent once, when the form appears.
  useEffect(() => {
    if (!asked.current) {
      asked.current = true
      if (receipt === null) {
        void send(false)
      }
    }
  }, [])

  // Only a send of this dialog that succeeded: a refusal says nothing about the user's inbox.
  const hasCode = receipt !== null
  useEffect(() => {
    // The field arrives after the dialog opened (the email had to be sent first): put the
    // focus on it, as the dialog does for a field that is there from the start.
    if (hasCode) {
      form.current?.querySelector<HTMLElement>('input')?.focus()
    }
  }, [hasCode])

  const submit = async () => {
    setResent(false)
    if (code.length !== CODE_LENGTH) {
      setIncomplete(true)
      return
    }
    setIncomplete(false)
    limits.mark('verify')
    setAction('verify')
    if (!(await props.submit({ method: 'email_code', code }))) {
      // A wrong code is retyped from scratch.
      setCode('')
    }
  }

  const retry = (seconds: number) =>
    seconds > 0 ? formatText(t.common.retryIn, { time: formatDuration(seconds, t) }) : null

  if (receipt === null) {
    return (
      <Form onSubmit={() => void send(false)} failure={sendError} blocked={sending || sendWait > 0}>
        {sending ? <p className='tula-text'>{t.stepUp.emailSending}</p> : null}
        <FormError message={sendError?.message ?? null} detail={retry(sendWait)} />
        {sending ? null : (
          <Button type='submit' pending={sending} disabled={sendWait > 0}>
            {t.stepUp.emailSend}
          </Button>
        )}
      </Form>
    )
  }

  const wrong = action === 'verify' && props.error?.code === 'verification.invalid_code'
  const hint = attemptsLeft(props.error, t)
  const codeErrors = incomplete
    ? [t.verification.codeIncomplete]
    : wrong && props.error
      ? [hint ? `${props.error.message} ${hint}` : props.error.message]
      : []
  // A resend refused for being too soon is not a failure to announce: the resend button says it.
  const formMessage =
    wrong || (action === 'send' && sendError?.code === 'rate_limited')
      ? null
      : (error?.message ?? null)
  return (
    <div ref={form}>
      <Form
        onSubmit={submit}
        failure={incomplete || (action === 'verify' ? props.error : null)}
        blocked={isPending || verifyWait > 0}
      >
        <p className='tula-text'>
          {formatText(t.stepUp.emailSubtitle, { destination: receipt.destination })}
        </p>
        <FormError message={formMessage} detail={retry(verifyWait)} />
        <CodeField
          value={code}
          onValue={(value) => {
            setCode(value)
            setIncomplete(false)
          }}
          errors={codeErrors}
        />
        <Button type='submit' pending={isPending} disabled={verifyWait > 0}>
          {t.stepUp.submit}
        </Button>
        <div className='tula-actions'>
          <ResendButton secondsLeft={sendWait} pending={sending} onResend={() => void send(true)} />
        </div>
        <Status message={resent ? t.verification.resent : null} />
      </Form>
    </div>
  )
}

/**
 * The step-up dialog: asks for the factor the server said this user can step up with, sends
 * it (`client.session.stepUp`) and reports whether the session was stepped up. What is typed
 * lives in the dialog's state and goes when it closes.
 *
 * A user with a second factor is asked for it and nothing else (their passkey is one of the
 * ways, where they have one). Without one: their passkey when they have one and the browser
 * can use it, else the password, with the other ways the server lists one click away (a code
 * by email is sent only when they choose it, or at once when it is all they have).
 */
function StepUpDialog(props: { methods: readonly StepUpMethod[]; onDone(proven: boolean): void }) {
  const { t } = useUi()
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const { methods, onDone } = props
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<TulaError | null>(null)
  const second = drawableFactors(methods)
  // A code factor means the user has two-step verification: nothing weaker is offered.
  const strong = second.some((method) => method !== 'passkey')
  const signedIn = state.status === 'signed-in'
  const passkeySupported = usePasskeySupport()
  type View = 'passkey' | 'password' | 'email'
  const views: View[] = strong
    ? []
    : [
        // Not ruled out until the browser has been asked; then only where it can.
        ...(methods.includes('passkey') && passkeySupported !== false
          ? (['passkey'] as const)
          : []),
        ...(methods.includes('password') ? (['password'] as const) : []),
        ...(methods.includes('email_code') ? (['email'] as const) : []),
      ]
  const [chosen, setChosen] = useState<View | null>(null)
  const view: View | undefined = chosen && views.includes(chosen) ? chosen : views[0]
  // The receipt of the code this dialog sent. Held here, not in the form, so that looking at
  // the password form and coming back neither sends a second email nor forgets the first.
  const [receipt, setReceipt] = useState<{ sessionId: string; value: StepUpPrepared } | null>(null)
  const sessionId = state.status === 'signed-in' ? state.sessionId : null
  const body = useRef<HTMLDivElement>(null)
  const switched = useRef(false)
  useEffect(() => {
    // Switching between the ways: focus follows to the new form's field, or to the passkey's
    // button (the emailed code's field focuses itself once the email was sent).
    if (switched.current && view !== 'email') {
      body.current?.querySelector<HTMLElement>('input, button')?.focus()
    }
  }, [view])
  const choose = (next: View) => {
    switched.current = true
    setError(null)
    setChosen(next)
  }

  useEffect(() => {
    // Signed out underneath the dialog (another tab, a revoked session): nothing to prove.
    if (!signedIn) {
      onDone(false)
    }
  }, [signedIn, onDone])

  const submit = async (proof: StepUpProof): Promise<boolean> => {
    setPending(true)
    setError(null)
    try {
      await client.session.stepUp(proof)
    } catch (caught) {
      setError(toTulaError(caught))
      setPending(false)
      return false
    }
    onDone(true)
    return true
  }
  const submitPasskey = async (signal: AbortSignal): Promise<boolean> => {
    setPending(true)
    setError(null)
    try {
      await client.session.stepUpWithPasskey({ signal })
    } catch (caught) {
      setError(toTulaError(caught))
      setPending(false)
      return false
    }
    onDone(true)
    return true
  }
  const cancel = () => onDone(false)
  const labels: Record<View, string> = {
    passkey: t.passkey.useInstead,
    password: t.stepUp.passwordInstead,
    email: t.stepUp.emailInstead,
  }
  const others = views.filter(
    (other) => other !== view && (other !== 'passkey' || passkeySupported === true)
  )
  // A passkey is all this user could step up with, and this browser cannot use one.
  const passkeyOnly = !strong && views.length === 0 && methods.includes('passkey')
  return (
    <Modal title={t.stepUp.title} onCancel={cancel}>
      {strong ? (
        <SecondFactorForm
          methods={second}
          isPending={isPending}
          error={error}
          submitLabel={t.stepUp.submit}
          totpSubtitle={t.stepUp.totpSubtitle}
          backupSubtitle={t.stepUp.backupSubtitle}
          passkeySubtitle={t.passkey.stepUpSubtitle}
          submit={submit}
          submitPasskey={submitPasskey}
        />
      ) : view !== undefined ? (
        <div ref={body}>
          {view === 'passkey' ? (
            <PasskeyPanel
              subtitle={t.passkey.stepUpSubtitle}
              isPending={isPending}
              error={error}
              use={submitPasskey}
            />
          ) : view === 'email' ? (
            <EmailCodeStepUp
              isPending={isPending}
              error={error}
              // A receipt belongs to the session that asked for it.
              receipt={receipt?.sessionId === sessionId ? receipt.value : null}
              onReceipt={(value) => setReceipt(sessionId === null ? null : { sessionId, value })}
              submit={submit}
            />
          ) : (
            <PasswordStepUp isPending={isPending} error={error} submit={submit} />
          )}
          {others.length > 0 ? (
            <div className='tula-actions'>
              {others.map((other) => (
                <Button key={other} kind='link' onClick={() => choose(other)}>
                  {labels[other]}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className='tula-text'>{passkeyOnly ? t.passkey.unsupported : t.stepUp.noMethod}</p>
      )}
      <Button kind='secondary' onClick={cancel}>
        {strong || view !== undefined ? t.stepUp.cancel : t.stepUp.close}
      </Button>
    </Modal>
  )
}

/**
 * Draws the provider's current prompt, in a modal dialog above the app. It lives in the
 * provider, not in the component that asked: a sign-in that enrolled an authenticator signs
 * the user in, an app usually unmounts its sign-in page at that moment, and the backup codes
 * must still be shown.
 */
export function PromptHost(props: { prompt: Prompt | null; onClose(): void }) {
  const { prompt, onClose } = props
  if (prompt === null) {
    return null
  }
  return (
    <Root appearance={undefined}>
      {prompt.kind === 'step-up' ? (
        <StepUpDialog
          methods={prompt.methods}
          onDone={(proven) => {
            onClose()
            prompt.resolve(proven)
          }}
        />
      ) : (
        <BackupCodesDialog
          codes={prompt.codes}
          onDone={() => {
            onClose()
            prompt.resolve()
          }}
        />
      )}
    </Root>
  )
}

/**
 * Says that a sign-out did not reach the server, and offers to try again.
 *
 * `@tula/core` forgets the session in this client before it tells the server, so by the time a
 * sign-out fails the app already renders its signed-out side and the component that asked is
 * usually gone. The server may still hold the session and the browser its cookie: the next
 * page load would be signed in again. That is why this is the provider's, why it is an alert,
 * and why nothing navigates until a sign-out went through.
 *
 * @param props.retry - Signs out again; resolves `true` when the server was told.
 * @param props.onClose - The user closed it without trying again.
 */
export function SignOutFailedDialog(props: { retry(): Promise<boolean>; onClose(): void }) {
  const { t } = useUi()
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const { retry, onClose } = props
  const [isPending, setPending] = useState(false)
  const [failures, setFailures] = useState(1)
  const signedIn = state.status === 'signed-in'
  useEffect(() => {
    // Someone signed in underneath the dialog: the sign-out it speaks of is no longer theirs.
    if (signedIn) {
      onClose()
    }
  }, [signedIn, onClose])
  const again = async () => {
    setPending(true)
    if (!(await retry())) {
      setFailures((count) => count + 1)
      setPending(false)
    }
  }
  return (
    <Modal title={t.signOutFailed.title} onCancel={onClose}>
      {/* A new element for every failure, so that a second one is announced again. */}
      <FormError key={failures} message={t.signOutFailed.message} />
      <Button pending={isPending} onClick={() => void again()}>
        {t.signOutFailed.retry}
      </Button>
      <Button kind='secondary' onClick={onClose}>
        {t.signOutFailed.close}
      </Button>
    </Modal>
  )
}

function BackupCodesDialog(props: { codes: readonly string[]; onDone(): void }) {
  const { t } = useUi()
  return (
    <Modal title={t.mfa.backupCodesTitle}>
      <BackupCodesPanel codes={props.codes} onDone={props.onDone} />
    </Modal>
  )
}
