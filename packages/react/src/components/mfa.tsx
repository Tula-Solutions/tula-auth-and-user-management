import type {
  FactorEnrolmentResult,
  FlowStep,
  SecondFactorProof,
  TotpEnrolment,
  TulaError,
} from '@tula/core'
import { useEffect, useId, useRef, useState } from 'react'
import { formatText } from '../localization'
import type { QrDrawing } from '../qr'
import { CODE_LENGTH, digitsOnly, useRetryAfter } from './flow-screens'
import { type FieldResolver, formatDuration, placeErrors } from './form-errors'
import { PasskeyPanel, usePasskeySupport } from './passkey'
import { Button, Card, Form, FormError, Status, TextField, useUi } from './ui'

/** Modules of white around a QR code: the quiet zone a scanner needs (the standard's four). */
const QUIET_ZONE = 4

/** Longest backup code a field takes: ten characters, with room for spaces and a dash. */
const BACKUP_CODE_MAX_LENGTH = 24

/**
 * How long the object URL of a downloaded backup-codes file is kept before it is revoked.
 * Long enough for a browser that reads the blob after the click has returned.
 */
export const BACKUP_CODES_URL_LIFETIME_MS = 60_000

/** A wrong authenticator or backup code belongs to the code field. */
const codeField: FieldResolver = (code, field) =>
  field === 'code' || code === 'mfa.invalid_code' || code === 'mfa.enrolment_expired'
    ? 'code'
    : null

/** A second factor this version of the components can ask for. */
export type DrawableFactor = 'totp' | 'backup_code' | 'passkey'

/** A second factor proven by typing a code. */
type CodeFactor = Exclude<DrawableFactor, 'passkey'>

/** The field for a 6-digit authenticator code. */
export function TotpField(props: {
  value: string
  onValue(value: string): void
  errors?: string[]
}) {
  const { t } = useUi()
  return (
    <TextField
      part='codeInput'
      label={t.mfa.totpLabel}
      hint={t.mfa.totpHint}
      name='totp'
      type='text'
      inputMode='numeric'
      autoComplete='one-time-code'
      pattern='[0-9]*'
      maxLength={CODE_LENGTH + 4}
      value={props.value}
      onValue={(value) => props.onValue(digitsOnly(value))}
      errors={props.errors}
      required
    />
  )
}

/** The field for a backup code, typed as the user has it: case, spaces and dashes are free. */
export function BackupCodeField(props: {
  value: string
  onValue(value: string): void
  errors?: string[]
}) {
  const { t } = useUi()
  return (
    <TextField
      label={t.mfa.backupLabel}
      hint={t.mfa.backupHint}
      name='backup-code'
      type='text'
      autoComplete='off'
      autoCapitalize='none'
      autoCorrect='off'
      spellCheck={false}
      maxLength={BACKUP_CODE_MAX_LENGTH}
      value={props.value}
      onValue={props.onValue}
      errors={props.errors}
      required
    />
  )
}

/**
 * A QR code of an `otpauth://` URI, as inline SVG. The encoder is loaded when the code is
 * first drawn. Always dark on white, whatever the theme: scanners expect it. If it cannot be
 * drawn the setup key beside it is the way in, so nothing is shown in its place.
 */
function QrCode(props: { uri: string }) {
  const { el, t } = useUi()
  const { uri } = props
  const [drawing, setDrawing] = useState<QrDrawing | 'failed' | null>(null)
  useEffect(() => {
    let stopped = false
    setDrawing(null)
    import('../qr')
      .then(({ qrDrawing }) => qrDrawing(uri))
      .catch(() => 'failed' as const)
      .then((result) => {
        if (!stopped) {
          setDrawing(result)
        }
      })
    return () => {
      stopped = true
    }
  }, [uri])
  if (drawing === 'failed') {
    return null
  }
  if (drawing === null) {
    return (
      <div {...el('qrCode')}>
        <p className='tula-text'>{t.mfa.qrLoading}</p>
      </div>
    )
  }
  const side = drawing.size + QUIET_ZONE * 2
  return (
    <div {...el('qrCode')}>
      <svg
        role='img'
        aria-label={t.mfa.qrLabel}
        viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${side} ${side}`}
        shapeRendering='crispEdges'
      >
        <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={side} height={side} fill='#fff' />
        <path d={drawing.path} fill='#000' />
      </svg>
    </div>
  )
}

/** The QR code and, as its text alternative, the setup key in groups of four. */
export function EnrolmentDetails(props: { enrolment: TotpEnrolment }) {
  const { el, t } = useUi()
  const labelId = useId()
  const hintId = useId()
  const { secret, uri } = props.enrolment
  return (
    <>
      <p className='tula-text'>{t.mfa.scanInstruction}</p>
      <QrCode uri={uri} />
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group, not a form's fieldset */}
      <div
        className='tula-secret-block'
        role='group'
        aria-labelledby={labelId}
        aria-describedby={hintId}
      >
        <p {...el('label')} id={labelId}>
          {t.mfa.secretLabel}
        </p>
        {/* A group of four is easier to copy by eye; apps ignore the spaces. */}
        <code {...el('secret')}>{secret.replace(/(.{4})(?=.)/g, '$1 ')}</code>
        <p {...el('hint')} id={hintId}>
          {t.mfa.secretHint}
        </p>
      </div>
    </>
  )
}

/**
 * The backup codes, shown once: the list, copy, download as a text file, and a checkbox the
 * user must tick before the screen lets them go.
 */
export function BackupCodesPanel(props: { codes: readonly string[]; onDone(): void }) {
  const { el, t } = useUi()
  const { codes } = props
  const checkboxId = useId()
  const errorId = useId()
  const checkbox = useRef<HTMLInputElement>(null)
  const [saved, setSaved] = useState(false)
  const [missing, setMissing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const text = `${codes.join('\n')}\n`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus(t.mfa.copied)
    } catch {
      setStatus(t.mfa.copyFailed)
    }
  }
  // Object URLs of downloads still alive, each with the timer that will revoke it.
  const urls = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const pending = urls.current
    return () => {
      // The screen is going: whatever the browser has not read by now is released with it.
      for (const [url, timer] of pending) {
        clearTimeout(timer)
        URL.revokeObjectURL(url)
      }
      pending.clear()
    }
  }, [])
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = t.mfa.downloadFileName
    link.hidden = true
    // In the document while it is clicked, and the URL kept for a while after: some browsers
    // (Safari, some Firefox versions) start the download after the click has returned, and a
    // URL revoked in the same tick saves an empty file. This is the only copy of the codes.
    document.body.append(link)
    link.click()
    link.remove()
    const release = () => {
      if (urls.current.delete(url)) {
        URL.revokeObjectURL(url)
      }
    }
    urls.current.set(url, setTimeout(release, BACKUP_CODES_URL_LIFETIME_MS))
  }
  const done = () => {
    if (!saved) {
      setMissing(true)
      checkbox.current?.focus()
      return
    }
    props.onDone()
  }

  return (
    <div className='tula-backup'>
      <p className='tula-text'>{t.mfa.backupCodesIntro}</p>
      <ul {...el('backupCodes')} aria-label={t.mfa.backupCodesList}>
        {codes.map((code) => (
          <li key={code} {...el('backupCode')}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className='tula-button-row'>
        <Button kind='secondary' onClick={copy}>
          {t.mfa.copy}
        </Button>
        <Button kind='secondary' onClick={download}>
          {t.mfa.download}
        </Button>
      </div>
      <Status message={status} />
      <div {...el('checkbox', missing && 'tula-is-invalid')}>
        <input
          ref={checkbox}
          id={checkboxId}
          type='checkbox'
          checked={saved}
          onChange={(event) => {
            setSaved(event.target.checked)
            setMissing(false)
          }}
          aria-invalid={missing || undefined}
          aria-describedby={missing ? errorId : undefined}
          required
        />
        <label htmlFor={checkboxId}>{t.mfa.saved}</label>
      </div>
      {missing ? (
        <div {...el('fieldError')} id={errorId} role='alert'>
          {t.mfa.savedRequired}
        </div>
      ) : null}
      <Button onClick={done}>{t.mfa.done}</Button>
    </div>
  )
}

/**
 * One second-factor form: the 6-digit authenticator code, a backup code, or the user's
 * passkey, with a switch between the ones that are offered. Used by the sign-in and reset
 * screens and by the step-up dialog; it holds what was typed only while it is on screen.
 *
 * A code is asked for first where one is offered: that form is the same in every browser. The
 * passkey is one click away where the browser can use one, and is the screen itself where it
 * is all the user has.
 */
export function SecondFactorForm(props: {
  methods: readonly DrawableFactor[]
  isPending: boolean
  error: TulaError | null
  submitLabel: string
  totpSubtitle: string
  backupSubtitle: string
  submit(proof: SecondFactorProof): Promise<boolean>
  /** Above the passkey button. Defaults to the sign-in wording. */
  passkeySubtitle?: string
  /** Runs the passkey ceremony and sends its proof. Without it a passkey is not offered. */
  submitPasskey?(signal: AbortSignal): Promise<boolean>
}) {
  const { t } = useUi()
  const { error, isPending, submitPasskey } = props
  const passkeySupported = usePasskeySupport()
  const methods = props.methods.filter((offered) => offered !== 'passkey' || submitPasskey)
  const [chosen, setChosen] = useState<DrawableFactor | null>(null)
  const method: DrawableFactor =
    chosen && methods.includes(chosen) ? chosen : (methods[0] ?? 'totp')
  // Which kind of proof the error on screen is about: a dismissed passkey dialog says nothing
  // about a code, nor a wrong code about the passkey.
  const [acted, setActed] = useState<'code' | 'passkey' | null>(null)
  const [code, setCode] = useState('')
  const [local, setLocal] = useState<{ message: string } | null>(null)
  const limits = useRetryAfter<'verify'>(error, 'verify')
  const wait = limits.secondsLeft('verify')
  const shown = acted === null || (acted === 'passkey') === (method === 'passkey') ? error : null
  const placed = placeErrors(shown, codeField)
  const errors = local ? [local.message] : (placed.fields.code ?? [])
  // The passkey is offered as a way out of a code form only where the browser can use one.
  const others = methods.filter(
    (offered) => offered !== method && (offered !== 'passkey' || passkeySupported === true)
  )
  const form = useRef<HTMLDivElement>(null)
  const switched = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the method changes
  useEffect(() => {
    // Switching replaces the field: put the focus in the new one, where the user acts next.
    if (switched.current) {
      form.current?.querySelector<HTMLElement>('input, button')?.focus()
    }
  }, [method])

  const change = (value: string) => {
    setCode(value)
    setLocal(null)
  }
  const submit = async () => {
    const value = code.trim()
    if (method === 'totp' ? value.length !== CODE_LENGTH : value === '') {
      setLocal({ message: method === 'totp' ? t.mfa.codeIncomplete : t.mfa.backupRequired })
      return
    }
    setLocal(null)
    limits.mark('verify')
    setActed('code')
    if (!(await props.submit({ method: method as CodeFactor, code: value }))) {
      // A wrong code is retyped from scratch.
      setCode('')
    }
  }
  const labels: Record<DrawableFactor, string> = {
    totp: t.mfa.useAuthenticator,
    backup_code: t.mfa.useBackupCode,
    passkey: t.passkey.useInstead,
  }
  const switches =
    others.length > 0 ? (
      <div className='tula-actions'>
        {others.map((other) => (
          <Button
            key={other}
            kind='link'
            onClick={() => {
              switched.current = true
              setChosen(other)
              change('')
            }}
          >
            {labels[other]}
          </Button>
        ))}
      </div>
    ) : null

  if (method === 'passkey' && submitPasskey) {
    return (
      <div className='tula-form'>
        <div className='tula-field-slot' ref={form}>
          <PasskeyPanel
            subtitle={props.passkeySubtitle ?? t.passkey.secondFactorSubtitle}
            isPending={isPending}
            error={shown}
            use={(signal) => {
              setActed('passkey')
              return submitPasskey(signal)
            }}
          />
        </div>
        {switches}
      </div>
    )
  }

  return (
    <Form onSubmit={submit} failure={local ?? shown} blocked={isPending || wait > 0}>
      <p className='tula-text'>{method === 'totp' ? props.totpSubtitle : props.backupSubtitle}</p>
      <div className='tula-field-slot' ref={form}>
        <FormError
          message={placed.form}
          detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
        />
        {method === 'totp' ? (
          <TotpField value={code} onValue={change} errors={errors} />
        ) : (
          <BackupCodeField value={code} onValue={change} errors={errors} />
        )}
      </div>
      <Button type='submit' pending={isPending} disabled={wait > 0}>
        {props.submitLabel}
      </Button>
      {switches}
    </Form>
  )
}

/**
 * The second factors this version can draw, of the ones a step offers. A method a newer
 * server adds is left out; with none left the caller draws the "not supported" screen.
 */
export function drawableFactors(options: unknown): DrawableFactor[] {
  const offered: readonly unknown[] = Array.isArray(options) ? options : []
  return (['totp', 'backup_code', 'passkey'] as const).filter((method) => offered.includes(method))
}

/** Whether a `needs_factor_enrolment` step offers the one method this version can enrol. */
export function canEnrolTotp(methods: unknown): boolean {
  return Array.isArray(methods) && methods.includes('totp')
}

/** The `needs_second_factor` screen of sign-in and password reset. */
export function SecondFactorScreen(props: {
  methods: readonly DrawableFactor[]
  focusTitle: boolean
  isPending: boolean
  error: TulaError | null
  submit(proof: SecondFactorProof): Promise<FlowStep | null>
  /** Proves the user's passkey instead of a code. */
  submitPasskey?(signal: AbortSignal): Promise<FlowStep | null>
  onRestart(): void
}) {
  const { t } = useUi()
  const { submitPasskey } = props
  return (
    <Card
      title={t.mfa.secondFactorTitle}
      focusTitle={props.focusTitle}
      footer={
        <Button kind='link' onClick={props.onRestart}>
          {t.resetPassword.backToSignIn}
        </Button>
      }
    >
      <SecondFactorForm
        methods={props.methods}
        isPending={props.isPending}
        error={props.error}
        submitLabel={t.mfa.submit}
        totpSubtitle={t.mfa.totpSubtitle}
        backupSubtitle={t.mfa.backupSubtitle}
        submit={async (proof) => (await props.submit(proof)) !== null}
        submitPasskey={
          submitPasskey ? async (signal) => (await submitPasskey(signal)) !== null : undefined
        }
      />
    </Card>
  )
}

/**
 * The form that confirms a started enrolment: the QR code and setup key, and the code the app
 * shows. Shared by the in-flow screen and the profile section.
 */
export function EnrolmentConfirmForm(props: {
  enrolment: TotpEnrolment
  isPending: boolean
  error: TulaError | null
  confirm(code: string): Promise<boolean>
  onCancel(): void
}) {
  const { t } = useUi()
  const { error, isPending } = props
  const [code, setCode] = useState('')
  const [local, setLocal] = useState<{ message: string } | null>(null)
  const limits = useRetryAfter<'verify'>(error, 'verify')
  const wait = limits.secondsLeft('verify')
  const placed = placeErrors(error, codeField)

  const submit = async () => {
    if (code.length !== CODE_LENGTH) {
      setLocal({ message: t.mfa.codeIncomplete })
      return
    }
    setLocal(null)
    limits.mark('verify')
    if (!(await props.confirm(code))) {
      setCode('')
    }
  }
  return (
    <Form onSubmit={submit} failure={local ?? error} blocked={isPending || wait > 0}>
      <EnrolmentDetails enrolment={props.enrolment} />
      <FormError
        message={placed.form}
        detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
      />
      <TotpField
        value={code}
        onValue={(value) => {
          setCode(value)
          setLocal(null)
        }}
        errors={local ? [local.message] : (placed.fields.code ?? [])}
      />
      <div className='tula-button-row'>
        <Button type='submit' pending={isPending} disabled={wait > 0}>
          {t.mfa.confirmSubmit}
        </Button>
        <Button kind='secondary' onClick={props.onCancel}>
          {t.mfa.cancel}
        </Button>
      </div>
    </Form>
  )
}

/**
 * The `needs_factor_enrolment` screen: the app requires two-step verification and the user
 * has none. The secret is asked for when the user says so, lives in this screen's state and
 * goes with it.
 */
export function FactorEnrolmentScreen(props: {
  focusTitle: boolean
  isPending: boolean
  error: TulaError | null
  start(): Promise<TotpEnrolment | null>
  confirm(code: string): Promise<FactorEnrolmentResult | null>
  onRestart(): void
}) {
  const { t } = useUi()
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null)
  const begin = async () => {
    setEnrolment(await props.start())
  }
  return (
    <Card
      title={t.mfa.enrolTitle}
      subtitle={enrolment ? undefined : t.mfa.enrolRequired}
      focusTitle={props.focusTitle}
      footer={
        <Button kind='link' onClick={props.onRestart}>
          {t.resetPassword.backToSignIn}
        </Button>
      }
    >
      {enrolment ? (
        <EnrolmentConfirmForm
          enrolment={enrolment}
          isPending={props.isPending}
          error={props.error}
          confirm={async (code) => (await props.confirm(code)) !== null}
          onCancel={() => setEnrolment(null)}
        />
      ) : (
        <>
          <FormError message={props.error?.message ?? null} />
          <Button pending={props.isPending} onClick={begin}>
            {t.mfa.enrolStart}
          </Button>
        </>
      )}
    </Card>
  )
}
