import type { StepUpMethod, StepUpPrepared, StepUpProof, TulaError } from '@tula/core'
import { type ReactNode, type SyntheticEvent, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from '../hooks/use-auth-state'
import { formatText } from '../localization'
import { CODE_LENGTH, CodeField, ResendButton, useRetryAfter } from './flow-screens'
import { attemptsLeft, formatDuration } from './form-errors'
import { BackupCodesPanel, drawableFactors, SecondFactorForm } from './mfa'
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
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus()
      }
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
 * A user with a second factor is asked for it and nothing else. Without one: the password
 * when they have one, with a code by email as the other way when the server lists it (sent
 * only when they choose it); the emailed code at once when it is all they have.
 */
function StepUpDialog(props: { methods: readonly StepUpMethod[]; onDone(proven: boolean): void }) {
  const { t } = useUi()
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const { methods, onDone } = props
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<TulaError | null>(null)
  const second = drawableFactors(methods)
  const signedIn = state.status === 'signed-in'
  const canPassword = second.length === 0 && methods.includes('password')
  const canEmail = second.length === 0 && methods.includes('email_code')
  const [byEmail, setByEmail] = useState(!canPassword)
  // The receipt of the code this dialog sent. Held here, not in the form, so that looking at
  // the password form and coming back neither sends a second email nor forgets the first.
  const [receipt, setReceipt] = useState<{ sessionId: string; value: StepUpPrepared } | null>(null)
  const sessionId = state.status === 'signed-in' ? state.sessionId : null
  const body = useRef<HTMLDivElement>(null)
  const switched = useRef(false)
  useEffect(() => {
    // Switching between the password and the emailed code: focus follows to the new form's
    // field (the emailed code's field focuses itself once the email was sent).
    if (switched.current && !byEmail) {
      body.current?.querySelector<HTMLElement>('input')?.focus()
    }
  }, [byEmail])
  const choose = (email: boolean) => {
    switched.current = true
    setError(null)
    setByEmail(email)
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
  const cancel = () => onDone(false)
  return (
    <Modal title={t.stepUp.title} onCancel={cancel}>
      {second.length > 0 ? (
        <SecondFactorForm
          methods={second}
          isPending={isPending}
          error={error}
          submitLabel={t.stepUp.submit}
          totpSubtitle={t.stepUp.totpSubtitle}
          backupSubtitle={t.stepUp.backupSubtitle}
          submit={submit}
        />
      ) : canEmail && (byEmail || !canPassword) ? (
        <div ref={body}>
          <EmailCodeStepUp
            isPending={isPending}
            error={error}
            // A receipt belongs to the session that asked for it.
            receipt={receipt?.sessionId === sessionId ? receipt.value : null}
            onReceipt={(value) => setReceipt(sessionId === null ? null : { sessionId, value })}
            submit={submit}
          />
          {canPassword ? (
            <div className='tula-actions'>
              <Button kind='link' onClick={() => choose(false)}>
                {t.stepUp.passwordInstead}
              </Button>
            </div>
          ) : null}
        </div>
      ) : canPassword ? (
        <div ref={body}>
          <PasswordStepUp isPending={isPending} error={error} submit={submit} />
          {canEmail ? (
            <div className='tula-actions'>
              <Button kind='link' onClick={() => choose(true)}>
                {t.stepUp.emailInstead}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className='tula-text'>{t.stepUp.noMethod}</p>
      )}
      <Button kind='secondary' onClick={cancel}>
        {second.length > 0 || canPassword || canEmail ? t.stepUp.cancel : t.stepUp.close}
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

function BackupCodesDialog(props: { codes: readonly string[]; onDone(): void }) {
  const { t } = useUi()
  return (
    <Modal title={t.mfa.backupCodesTitle}>
      <BackupCodesPanel codes={props.codes} onDone={props.onDone} />
    </Modal>
  )
}
