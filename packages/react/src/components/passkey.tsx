import { isStepUpRequired, type Passkey, type SignInFlow, type TulaError } from '@tula/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useClientConfig } from '../hooks/use-password-checklist'
import { useStepUp } from '../hooks/use-step-up'
import { formatText } from '../localization'
import { KeyIcon } from './icons'
import { Button, Form, FormError, Heading, Status, TextField, useUi } from './ui'

/** Longest name a passkey may be given, as the API has it. */
const PASSKEY_NAME_MAX_LENGTH = 64

/**
 * Whether this browser can run a passkey ceremony. A fact about the browser, read after mount:
 * nothing during render touches `navigator`.
 *
 * @returns `null` until the component has mounted, then whether WebAuthn is there.
 */
export function usePasskeySupport(): boolean | null {
  const { client } = useTulaContext()
  const [supported, setSupported] = useState<boolean | null>(null)
  useEffect(() => {
    setSupported(client.signIn.canUsePasskey())
  }, [client])
  return supported
}

/**
 * Whether the environment has passkeys switched on, from the public configuration
 * (`signIn.methods` of `/v1/client/config` lists `passkey`).
 *
 * @returns `false` while the configuration is not known.
 */
export function usePasskeyOffered(): boolean {
  return useClientConfig()?.signIn.methods.includes('passkey') === true
}

/**
 * What a passkey ceremony last ended with. A dialog the user dismissed is not a failure to
 * announce as one, and not a success to draw as one: it is said quietly, in the neutral tone,
 * and everything else is the error it is.
 */
function PasskeyNotice(props: { error: TulaError | null }) {
  const { t } = useUi()
  const { error } = props
  const cancelled = error?.code === 'passkey.cancelled'
  return (
    <>
      <FormError message={error && !cancelled ? error.message : null} />
      <Status message={cancelled ? t.passkey.cancelled : null} tone='neutral' />
    </>
  )
}

/** The label of a passkey button: the key and the words. */
function PasskeyLabel(props: { children: string }) {
  const { el } = useUi()
  return (
    <>
      <span {...el('passkeyIcon')}>
        <KeyIcon />
      </span>
      {props.children}
    </>
  )
}

/**
 * Put the focus back on a passkey button once its ceremony has ended without success: the
 * browser's dialog took the focus and does not always return it.
 */
function useRefocus(failure: unknown) {
  const holder = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (failure) {
      holder.current?.querySelector('button')?.focus()
    }
  }, [failure])
  return holder
}

/**
 * "Sign in with a passkey": the button, and where `autofill` is set the request that lets the
 * browser offer passkeys on the address field (`autocomplete="username webauthn"`).
 *
 * A passkey sign-in is an attempt of its own, so its result is a flow handed to `onFlow`. Only
 * one WebAuthn request may be pending in a page: the autofill request is ended before the
 * button starts its ceremony, and started again when that ceremony ends without a sign-in
 * (dismissed, refused by the API, failed), so the address field keeps offering passkeys. The
 * autofill request has a signal of its own per run of its effect, so a second run (StrictMode,
 * Fast Refresh, `<Activity>`) does not end with the first one's.
 *
 * Both requests sign the client in before their flow comes back. On a screen with no step yet
 * that is indistinguishable from "was already signed in", so each takes `hold` for as long as
 * it is in flight (see `useCompletion`): the app's `onComplete` cannot lose to a redirect.
 *
 * Draws nothing where the environment has passkeys off or the browser has no WebAuthn.
 *
 * @param props.autofill - Also ask through the browser's autofill.
 * @param props.offered - Set where the server itself offered the `passkey` strategy; otherwise
 *   the environment's public configuration decides.
 * @param props.onFlow - Receives the sign-in, past its first factor.
 * @param props.hold - `useCompletion`'s hold, where the screen can be shown with no step.
 * @param props.disabled - Another action of the screen is pending.
 * @returns The button with its messages, or nothing.
 */
export function PasskeySignIn(props: {
  autofill?: boolean
  offered?: boolean
  onFlow(flow: SignInFlow): void
  hold?(): () => void
  disabled?: boolean
}) {
  const { t } = useUi()
  const { client } = useTulaContext()
  const configured = usePasskeyOffered()
  const offered = props.offered ?? configured
  const supported = usePasskeySupport() === true
  const { autofill = false } = props
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<TulaError | null>(null)
  // Bumped when the button's ceremony ends without a sign-in: a new autofill request follows.
  const [round, setRound] = useState(0)
  const background = useRef<AbortController | null>(null)
  const explicit = useRef<AbortController | null>(null)
  const onFlow = useRef(props.onFlow)
  onFlow.current = props.onFlow
  const hold = useRef(props.hold)
  hold.current = props.hold
  const holder = useRefocus(error)

  useEffect(() => {
    // Named so that a new round, which changes nothing else, runs this again.
    void round
    if (!autofill || !offered || !supported) {
      return
    }
    const leaving = new AbortController()
    background.current = leaving
    const wait = async () => {
      // Before the first await: from here on, the client being signed in may be this request's
      // doing, and its completion is handed on below before the hold is released.
      const release = hold.current?.()
      try {
        if (!(await client.signIn.canAutofillPasskey()) || leaving.signal.aborted) {
          return
        }
        const flow = await client.signIn.withPasskey({ autofill: true, signal: leaving.signal })
        // Handed on even if this screen has gone meanwhile: the sign-in happened (the client
        // is signed in, which is often what took the screen away) and must be completed.
        onFlow.current(flow)
      } catch (caught) {
        const failure = toTulaError(caught)
        // Ended by this screen, or by the user: nothing to say. A passkey the API refused is.
        if (!leaving.signal.aborted && failure.code !== 'passkey.cancelled') {
          setError(failure)
        }
      } finally {
        release?.()
      }
    }
    void wait()
    return () => leaving.abort()
  }, [autofill, offered, supported, client, round])

  useEffect(
    () => () => {
      // The screen is going: a dialog still open goes with it.
      explicit.current?.abort()
    },
    []
  )

  if (!offered || !supported) {
    return null
  }
  const start = async () => {
    if (explicit.current !== null) {
      return
    }
    // One WebAuthn request at a time: the one waiting in autofill makes way.
    background.current?.abort()
    const mine = new AbortController()
    explicit.current = mine
    setPending(true)
    setError(null)
    const release = hold.current?.()
    try {
      const flow = await client.signIn.withPasskey({ signal: mine.signal })
      // As above: a sign-in that happened is completed, whatever became of this screen.
      onFlow.current(flow)
    } catch (caught) {
      if (!mine.signal.aborted) {
        setError(toTulaError(caught))
        // Whatever it failed with (dismissed, refused, the network): the request waiting in
        // autofill made way for this one, and the address field should offer passkeys again.
        setRound((value) => value + 1)
      }
    } finally {
      release?.()
      explicit.current = null
      if (!mine.signal.aborted) {
        setPending(false)
      }
    }
  }
  return (
    <div className='tula-passkey' ref={holder}>
      <PasskeyNotice error={error} />
      <Button
        kind='secondary'
        pending={pending}
        disabled={props.disabled}
        onClick={() => void start()}
      >
        <PasskeyLabel>{t.passkey.signIn}</PasskeyLabel>
      </Button>
    </div>
  )
}

/**
 * "Use your passkey": the passkey as a second factor or a step-up. One button that opens the
 * browser's dialog; a dismissed dialog is said quietly and the button works again. Where the
 * browser has no WebAuthn it says so instead of offering a button that could only fail.
 *
 * @param props.subtitle - What the passkey is asked for.
 * @param props.error - Why the last try failed.
 * @param props.use - Runs the ceremony; given a signal that ends when the panel goes.
 * @returns The panel.
 */
export function PasskeyPanel(props: {
  subtitle: string
  isPending: boolean
  error: TulaError | null
  use(signal: AbortSignal): Promise<unknown>
}) {
  const { t } = useUi()
  const supported = usePasskeySupport()
  const ceremony = useRef<AbortController | null>(null)
  const holder = useRefocus(props.error)
  useEffect(() => () => ceremony.current?.abort(), [])
  const use = async () => {
    const mine = new AbortController()
    ceremony.current = mine
    await props.use(mine.signal)
  }
  if (supported === false) {
    return <p className='tula-text'>{t.passkey.unsupported}</p>
  }
  return (
    <div className='tula-passkey' ref={holder}>
      <p className='tula-text'>{props.subtitle}</p>
      <PasskeyNotice error={props.error} />
      <Button pending={props.isPending} onClick={() => void use()}>
        <PasskeyLabel>{t.passkey.use}</PasskeyLabel>
      </Button>
    </div>
  )
}

/** A date as the profile shows it. */
function day(value: string, locale: string): string {
  return new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' })
}

/** One passkey: its name, what kind it is, when it was added and used, and its two actions. */
function PasskeyRow(props: {
  passkey: Passkey
  editing: 'rename' | 'remove' | null
  busy: boolean
  locked: boolean
  error: TulaError | null
  onEdit(mode: 'rename' | 'remove' | null): void
  onRename(name: string): void
  onRemove(): void
}) {
  const { el, t } = useUi()
  const { passkey, editing } = props
  const questionId = useId()
  const [name, setName] = useState(passkey.name)
  const [missing, setMissing] = useState(false)
  const editor = useRef<HTMLDivElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const opened = useRef<'rename' | 'remove' | null>(null)
  useEffect(() => {
    if (editing !== null) {
      // The editor arrives under the row: the focus goes to where the user acts next (the name
      // field; for a removal the safe answer).
      opened.current = editing
      editor.current?.querySelector<HTMLElement>('input, button')?.focus()
    } else if (opened.current !== null) {
      // The editor is gone and its buttons with it: back to the button that opened it.
      const index = opened.current === 'rename' ? 0 : 1
      opened.current = null
      actions.current?.querySelectorAll('button')[index]?.focus()
    }
  }, [editing])
  const open = (mode: 'rename' | 'remove') => {
    setName(passkey.name)
    setMissing(false)
    props.onEdit(mode)
  }
  const save = () => {
    const next = name.trim()
    if (next === '') {
      setMissing(true)
      return
    }
    props.onRename(next)
  }
  return (
    <li {...el('passkeyItem')}>
      <span {...el('passkeyIcon')}>
        <KeyIcon />
      </span>
      <div className='tula-passkey-text'>
        <p className='tula-passkey-name'>{passkey.name}</p>
        <p className='tula-passkey-meta'>
          <span>{passkey.synced ? t.passkey.synced : t.passkey.deviceBound}</span>
          <span>{formatText(t.passkey.created, { date: day(passkey.createdAt, t.locale) })}</span>
          <span>
            {passkey.lastUsedAt
              ? formatText(t.passkey.lastUsed, { date: day(passkey.lastUsedAt, t.locale) })
              : t.passkey.neverUsed}
          </span>
        </p>
      </div>
      <div className='tula-button-row tula-is-compact' ref={actions}>
        <Button
          kind='secondary'
          disabled={props.locked || editing !== null}
          aria-label={formatText(t.passkey.renameLabel, { name: passkey.name })}
          onClick={() => open('rename')}
        >
          {t.passkey.rename}
        </Button>
        <Button
          kind='danger'
          disabled={props.locked || editing !== null}
          aria-label={formatText(t.passkey.removeLabel, { name: passkey.name })}
          onClick={() => open('remove')}
        >
          {t.passkey.remove}
        </Button>
      </div>
      {editing === 'rename' ? (
        <div className='tula-passkey-editor' ref={editor}>
          <Form onSubmit={save} failure={missing || props.error} blocked={props.busy}>
            <TextField
              label={t.passkey.nameLabel}
              name='passkey-name'
              type='text'
              autoComplete='off'
              maxLength={PASSKEY_NAME_MAX_LENGTH}
              value={name}
              onValue={(value) => {
                setName(value)
                setMissing(false)
              }}
              errors={missing ? [t.passkey.nameRequired] : []}
              required
            />
            <div className='tula-button-row tula-is-compact'>
              <Button type='submit' pending={props.busy}>
                {t.passkey.save}
              </Button>
              <Button kind='secondary' onClick={() => props.onEdit(null)}>
                {t.passkey.cancel}
              </Button>
            </div>
          </Form>
        </div>
      ) : null}
      {editing === 'remove' ? (
        // biome-ignore lint/a11y/useSemanticElements: a labelled question with its two answers, not a form's fieldset
        <div {...el('confirmation')} ref={editor} role='group' aria-labelledby={questionId}>
          <p className='tula-text' id={questionId}>
            {formatText(t.passkey.removeConfirm, { name: passkey.name })}
          </p>
          <div className='tula-button-row tula-is-compact'>
            <Button kind='secondary' onClick={() => props.onEdit(null)}>
              {t.passkey.cancel}
            </Button>
            <Button kind='danger' pending={props.busy} onClick={props.onRemove}>
              {t.passkey.removeConfirmButton}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * The "Passkeys" section of `<UserProfile>`: the user's passkeys (name, whether it is synced,
 * when it was added and last used), a way to add one on this device, to rename one and to
 * remove one after a confirmation.
 *
 * Adding, renaming and removing are sensitive changes and go through `useStepUp()`. What the
 * server refuses (the last way to sign in, the limit) and what the browser reports (this
 * device already has one) are shown as messages; a dismissed dialog is said quietly. In a
 * browser without WebAuthn the section says so and still lists, renames and removes.
 *
 * **The list is always loaded**, whether or not the environment has passkeys on: the API lets
 * a user list, rename and remove their passkeys with the method switched off, and a passkey
 * nobody can see is one nobody can remove. With the method off, a user who has passkeys gets
 * the section without "Add a passkey" and with one line saying new ones cannot be added; a
 * user who has none gets no section at all.
 *
 * Every result is checked against the session it was asked under before it is shown.
 *
 * @returns The section; nothing where the environment has passkeys switched off and the user
 *   has none (or the list is not known).
 */
export function PasskeysSection() {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const offered = usePasskeyOffered()
  const supported = usePasskeySupport()
  const withStepUp = useStepUp()
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<TulaError | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // A dismissed dialog is said in the neutral tone: nothing was done, so it is no success.
  const [cancelled, setCancelled] = useState(false)
  const [editing, setEditing] = useState<{ id: string; mode: 'rename' | 'remove' } | null>(null)
  const mounted = useRef(true)
  const ceremony = useRef<AbortController | null>(null)
  // Counts the tries at adding that ended without a passkey: each puts the focus back on "Add".
  const [addEnded, setAddEnded] = useState(0)
  const adder = useRefocus(addEnded)

  /** A check that the session a call started under is still the one signed in. */
  const guard = useCallback(() => {
    const sessionOf = () => (client.state.status === 'signed-in' ? client.state.sessionId : null)
    const started = sessionOf()
    return () => mounted.current && started !== null && sessionOf() === started
  }, [client])

  const load = useCallback(async () => {
    const current = guard()
    try {
      const next = await client.user.passkeys.list()
      if (current()) {
        setPasskeys(next)
      }
    } catch (caught) {
      if (current()) {
        setError(toTulaError(caught))
      }
    }
  }, [client, guard])
  useEffect(() => {
    mounted.current = true
    // Whatever the environment offers: what the user has can still be seen and removed.
    void load()
    return () => {
      mounted.current = false
      // A dialog still open belongs to the session that opened it.
      ceremony.current?.abort()
    }
  }, [load])

  /** Run one action; a step-up the user declined is their choice, not an error to show. */
  const run = async (name: string, work: (current: () => boolean) => Promise<void>) => {
    const current = guard()
    setBusy(name)
    setError(null)
    setMessage(null)
    setCancelled(false)
    try {
      await work(current)
    } catch (caught) {
      if (current() && !isStepUpRequired(caught)) {
        const failure = toTulaError(caught)
        if (failure.code === 'passkey.cancelled') {
          setMessage(t.passkey.cancelled)
          setCancelled(true)
        } else {
          setError(failure)
        }
      }
    } finally {
      if (current()) {
        setBusy(null)
      }
    }
  }
  const add = () =>
    run('add', async (current) => {
      const mine = new AbortController()
      ceremony.current = mine
      try {
        await withStepUp(() => client.user.passkeys.add({ signal: mine.signal }))
      } catch (caught) {
        if (current()) {
          setAddEnded((value) => value + 1)
        }
        throw caught
      }
      await load()
      if (current()) {
        setMessage(t.passkey.added)
      }
    })
  const rename = (passkey: Passkey, name: string) =>
    run(passkey.id, async (current) => {
      await withStepUp(() => client.user.passkeys.rename({ passkeyId: passkey.id, name }))
      await load()
      if (current()) {
        setEditing(null)
        setMessage(t.passkey.renamed)
      }
    })
  const remove = (passkey: Passkey) =>
    run(passkey.id, async (current) => {
      try {
        await withStepUp(() => client.user.passkeys.remove({ passkeyId: passkey.id }))
      } finally {
        if (current()) {
          setEditing(null)
        }
      }
      await load()
      if (current()) {
        setMessage(t.passkey.removed)
        // The row and its buttons are gone: the section's title is where reading resumes.
        title.current?.focus()
      }
    })

  // With passkeys off the section is for what the user still has. It also stays for as long
  // as it has something to say about a change just made (the last one was removed), so that
  // the confirmation and the focus do not vanish with the row.
  if (!offered && (passkeys ?? []).length === 0 && message === null) {
    return null
  }
  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId} headingRef={title}>
        {t.passkey.sectionTitle}
      </Heading>
      <p className='tula-text'>{t.passkey.intro}</p>
      <FormError message={error?.message ?? null} />
      {passkeys === null ? (
        <p className='tula-text'>{error ? null : t.passkey.loading}</p>
      ) : passkeys.length === 0 ? (
        <p className='tula-text'>{t.passkey.empty}</p>
      ) : (
        <ul {...el('passkeyList')}>
          {passkeys.map((passkey) => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              editing={editing?.id === passkey.id ? editing.mode : null}
              busy={busy === passkey.id}
              locked={busy !== null || (editing !== null && editing.id !== passkey.id)}
              error={error}
              onEdit={(mode) => {
                setError(null)
                setMessage(null)
                setEditing(mode === null ? null : { id: passkey.id, mode })
              }}
              onRename={(name) => void rename(passkey, name)}
              onRemove={() => void remove(passkey)}
            />
          ))}
        </ul>
      )}
      {!offered ? (
        <p {...el('hint')}>{t.passkey.addUnavailable}</p>
      ) : supported === false ? (
        <p {...el('hint')}>{t.passkey.addUnsupported}</p>
      ) : (
        <div className='tula-passkey' ref={adder}>
          <Button
            kind='secondary'
            pending={busy === 'add'}
            disabled={(busy !== null && busy !== 'add') || editing !== null}
            onClick={() => void add()}
          >
            <PasskeyLabel>{t.passkey.add}</PasskeyLabel>
          </Button>
        </div>
      )}
      <Status message={message} tone={cancelled ? 'neutral' : 'success'} />
    </section>
  )
}
