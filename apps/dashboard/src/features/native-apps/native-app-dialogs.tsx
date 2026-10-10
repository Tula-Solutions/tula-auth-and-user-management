import { useQueryClient } from '@tanstack/react-query'
import {
  type CreateNativeAppRequest,
  CreateNativeAppRequestSchema,
  MAX_APP_LINK_PATHS,
  MAX_CERT_FINGERPRINTS,
  NATIVE_APP_PLATFORMS,
  type NativeAppPlatform,
  nativeAppIdentifier,
  nativeAppWeakenings,
  normalizeAppLinkPaths,
  normalizeCertFingerprints,
  type UpdateNativeAppRequest,
  UpdateNativeAppRequestSchema,
} from '@tula/contract'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap } from '~/api/errors'
import { type NativeApp, useCreateNativeApp, useUpdateNativeApp } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Field, SelectField, TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { notify } from '~/components/toaster'
import { Textarea } from '~/components/ui/textarea'
import { WeakeningQuestion } from '~/features/hooks/hook-form'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { refreshNativeApps } from './queries'
import {
  fingerprintsOf,
  identifierOf,
  identityOf,
  linkPathsOf,
  type NativeAppAction,
  nativeAppMessageFor,
  pathsOf,
  platformLabel,
  wideningSentences,
} from './words'

/** What is wrong with a native app's form, by field. */
export interface NativeAppProblems {
  teamId?: string
  bundleId?: string
  packageName?: string
  sha256CertFingerprints?: string
  appLinkPaths?: string
  /** A failure that belongs to no field. */
  general?: string
}

/** One issue of a failed parse, as far as this form reads it. */
interface Issue {
  path: PropertyKey[]
  message: string
}

const FIELDS = [
  'teamId',
  'bundleId',
  'packageName',
  'sha256CertFingerprints',
  'appLinkPaths',
] as const

/**
 * Put a failed parse of the contract's request schema into the form's words.
 *
 * The rules are the schema's (`CreateNativeAppRequestSchema`, `UpdateNativeAppRequestSchema`)
 * and so are the sentences; this only says which field broke one, and names the entry when
 * the field is a list.
 *
 * @param issues - The parse's issues.
 * @returns The first problem of each field.
 */
export function nativeAppProblems(issues: readonly Issue[]): NativeAppProblems {
  const problems: NativeAppProblems = {}
  for (const issue of issues) {
    const field = FIELDS.find((name) => name === issue.path[0])
    if (field === undefined) {
      problems.general ??= issue.message
    } else if (
      (field === 'sha256CertFingerprints' || field === 'appLinkPaths') &&
      typeof issue.path[1] === 'number'
    ) {
      problems[field] ??= `Entry ${issue.path[1] + 1}: ${issue.message}`
    } else if (field === 'sha256CertFingerprints') {
      problems[field] ??= `Enter one to ${MAX_CERT_FINGERPRINTS} fingerprints, each once.`
    } else if (field === 'appLinkPaths') {
      problems[field] ??= `Enter at most ${MAX_APP_LINK_PATHS} paths.`
    } else {
      problems[field] ??= issue.message
    }
  }
  return problems
}

/**
 * Put the server's refusal of a native app's form on the field it is about.
 *
 * @param error - What the mutation threw, or nothing.
 * @param action - `create` when an app was being registered.
 * @returns The problems; empty when nothing failed.
 */
export function serverProblems(error: unknown, action: NativeAppAction): NativeAppProblems {
  if (!error) {
    return {}
  }
  const fields = fieldErrorMap(error)
  const problems: NativeAppProblems = {}
  for (const [path, message] of Object.entries(fields)) {
    const field = FIELDS.find((name) => path === name || path.startsWith(`${name}.`))
    if (field) {
      problems[field] ??= message
    }
  }
  return Object.keys(problems).length > 0
    ? problems
    : { general: nativeAppMessageFor(error, action) }
}

const TEAM_HINT =
  'The ten characters of your Apple team, in upper case: the App ID prefix in your developer account.'
const FINGERPRINT_HINT = `The SHA-256 fingerprints of the certificates the app is signed with, one per line (up to ${MAX_CERT_FINGERPRINTS}): 32 bytes as hex, with or without colons. With Play App Signing, use the app signing key’s fingerprint from the Play Console, and add the upload key’s only for builds you install yourself.`

function FingerprintsField({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  return (
    <Field label='Certificate fingerprints (SHA-256)' error={error} hint={FINGERPRINT_HINT}>
      {(control) => (
        <Textarea
          {...control}
          className='bg-field font-mono text-xs'
          rows={3}
          autoComplete='off'
          autoCapitalize='off'
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  )
}

const LINK_PATHS_HINT: Record<NativeAppPlatform, string> = {
  ios: `Optional. The exact paths of your domain this app opens instead of the browser, one per line (up to ${MAX_APP_LINK_PATHS}), such as /oauth/callback: no wildcard, query or trailing slash. List one, and https://<your domain><path> as an allowed redirect URL, to return a provider sign-in to the app by a link no other app can claim. Leave empty and the app is handed no link.`,
  android: `Optional. The exact paths of your domain this app opens as App Links, one per line (up to ${MAX_APP_LINK_PATHS}), such as /oauth/callback. Android’s file cannot name a path: with one or more here the app may claim every link of the domain, and its own manifest decides which it opens. Leave empty and the app is handed no link.`,
}

function LinkPathsField({
  platform,
  value,
  onChange,
  error,
}: {
  platform: NativeAppPlatform
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  return (
    <Field label='App link paths' error={error} hint={LINK_PATHS_HINT[platform]}>
      {(control) => (
        <Textarea
          {...control}
          className='bg-field font-mono text-xs'
          rows={2}
          autoComplete='off'
          autoCapitalize='off'
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  )
}

interface AddValues {
  platform: NativeAppPlatform
  teamId: string
  bundleId: string
  packageName: string
  fingerprints: string
  paths: string
}

const EMPTY: AddValues = {
  platform: 'ios',
  teamId: '',
  bundleId: '',
  packageName: '',
  fingerprints: '',
  paths: '',
}

/**
 * Register a native app: an iOS app (its team and bundle id) or an Android app (its package
 * name and the fingerprints of its signing certificates).
 *
 * Registering an app widens who the platforms believe (the contract's `nativeAppWeakenings`),
 * so it is always asked about first, before anything is sent; in a production environment
 * the bundle id or package name is typed.
 *
 * @param props - `open`; `onClose`.
 * @returns The dialog.
 */
export function AddNativeAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const create = useCreateNativeApp({ request: useEnvironmentRequest() })
  const [values, setValues] = useState<AddValues>(EMPTY)
  const [problems, setProblems] = useState<NativeAppProblems>({})
  // The request as it will be sent, held while the operator is asked about it.
  const [asking, setAsking] = useState<CreateNativeAppRequest | null>(null)
  // From the click until the dialog closes, which is after the list was read again: the
  // request has succeeded before that, and a live button would send it a second time.
  const [saving, setSaving] = useState(false)
  const { reset } = create

  useEffect(() => {
    if (!open) {
      setValues(EMPTY)
      setProblems({})
      setAsking(null)
      setSaving(false)
      reset()
    }
  }, [open, reset])

  function send(data: CreateNativeAppRequest) {
    setSaving(true)
    create.mutate(
      { data },
      {
        // A refusal is about the form (an app that is there by now, a full environment).
        onError: () => {
          setSaving(false)
          setAsking(null)
        },
        onSuccess: async () => {
          await refreshNativeApps(queryClient)
          notify('Native app registered')
          onClose()
        },
      }
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const paths = pathsOf(values.paths)
    // Left out when none was typed: the request is then what it was before paths existed.
    const linked = paths.length > 0 ? { appLinkPaths: paths } : {}
    const parsed = CreateNativeAppRequestSchema.safeParse(
      values.platform === 'ios'
        ? {
            platform: 'ios',
            teamId: values.teamId.trim(),
            bundleId: values.bundleId.trim(),
            ...linked,
          }
        : {
            platform: 'android',
            packageName: values.packageName.trim(),
            sha256CertFingerprints: dedupe(fingerprintsOf(values.fingerprints)),
            ...linked,
          }
    )
    create.reset()
    if (!parsed.success) {
      setProblems(nativeAppProblems(parsed.error.issues))
      return
    }
    setProblems({})
    setAsking(parsed.data)
  }

  if (asking !== null) {
    const identifier = nativeAppIdentifier(asking)
    return (
      <Modal
        open={open}
        onClose={onClose}
        title='Register this app?'
        description={
          <>
            You are registering the {platformLabel(asking.platform)} app{' '}
            <bdi className='font-mono break-all'>{identifier}</bdi>.
          </>
        }
      >
        <WeakeningQuestion
          sentences={wideningSentences(null, asking)}
          requireText={environment.kind === 'production' ? identifier : undefined}
          pending={saving}
          confirmLabel='Register app'
          onConfirm={() => send(asking)}
          onCancel={() => setAsking(null)}
        />
      </Modal>
    )
  }

  const shown = { ...serverProblems(create.error, 'create'), ...problems }
  const set = (patch: Partial<AddValues>) => setValues({ ...values, ...patch })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title='Register a native app'
      description='The server names a registered app in the file its platform fetches to believe that the app is yours.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <SelectField
          label='Platform'
          value={values.platform}
          onChange={(event) => set({ platform: event.target.value as NativeAppPlatform })}
        >
          {NATIVE_APP_PLATFORMS.map((platform) => (
            <option key={platform} value={platform}>
              {platformLabel(platform)}
            </option>
          ))}
        </SelectField>
        {values.platform === 'ios' ? (
          <>
            <TextField
              label='Team ID'
              autoComplete='off'
              autoCapitalize='characters'
              spellCheck={false}
              placeholder='A1B2C3D4E5'
              value={values.teamId}
              onChange={(event) => set({ teamId: event.target.value })}
              error={shown.teamId}
              hint={TEAM_HINT}
            />
            <TextField
              label='Bundle ID'
              autoComplete='off'
              autoCapitalize='off'
              spellCheck={false}
              placeholder='com.example.app'
              value={values.bundleId}
              onChange={(event) => set({ bundleId: event.target.value })}
              error={shown.bundleId}
              hint='Exactly as in Xcode, case included. It cannot be changed later: another bundle ID is another app.'
            />
          </>
        ) : (
          <>
            <TextField
              label='Package name'
              autoComplete='off'
              autoCapitalize='off'
              spellCheck={false}
              placeholder='com.example.app'
              value={values.packageName}
              onChange={(event) => set({ packageName: event.target.value })}
              error={shown.packageName}
              hint='The applicationId of the build, exactly. It cannot be changed later: another package name is another app.'
            />
            <FingerprintsField
              value={values.fingerprints}
              onChange={(fingerprints) => set({ fingerprints })}
              error={shown.sha256CertFingerprints}
            />
          </>
        )}
        <LinkPathsField
          platform={values.platform}
          value={values.paths}
          onChange={(paths) => set({ paths })}
          error={shown.appLinkPaths}
        />
        {shown.general ? (
          <p role='alert' className='text-sm text-destructive'>
            {shown.general}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit'>Continue</ActionButton>
        </div>
      </form>
    </Modal>
  )
}

/**
 * What was typed, with an entry that repeats an earlier one (in any spelling) left out: a
 * list of fingerprints is a set, and pasting one twice is not a mistake to refuse.
 */
function dedupe(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const [normal] = normalizeCertFingerprints([entry])
    if (normal === undefined) {
      // Not a fingerprint: kept, so that the schema says which entry it is.
      return true
    }
    if (seen.has(normal)) {
      return false
    }
    seen.add(normal)
    return true
  })
}

function typedOf(app: NativeApp): string {
  if (app.platform === 'ios') {
    return app.teamId
  }
  return app.platform === 'android' ? app.sha256CertFingerprints.join('\n') : ''
}

/** The question's title for a change that widens: named for what it widens. */
function wideningTitle(widened: readonly string[]): string {
  if (widened.includes('teamId')) {
    return 'Move the app to another team?'
  }
  return widened.includes('sha256CertFingerprints')
    ? 'Add a certificate?'
    : 'Hand the app more links?'
}

/**
 * Change an iOS app's team, an Android app's certificate fingerprints, or either's app-link
 * paths. The fingerprints typed replace the stored set, and so do the paths. A change that
 * widens who the platforms believe or what the app is handed (another team, a gained
 * fingerprint, a gained path) is asked about first; taking one away is not. Only what
 * differs is sent.
 *
 * @param props - `app`: the app as listed; `open` and `onClose`.
 * @returns The dialog.
 */
export function EditNativeAppDialog({
  app,
  open,
  onClose,
}: {
  app: NativeApp
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const update = useUpdateNativeApp({ request: useEnvironmentRequest() })
  const [typed, setTyped] = useState(() => typedOf(app))
  const [typedPaths, setTypedPaths] = useState(() => linkPathsOf(app).join('\n'))
  const [problems, setProblems] = useState<NativeAppProblems>({})
  const [asking, setAsking] = useState<UpdateNativeAppRequest | null>(null)
  // As in the dialog above: live again only once the dialog has closed.
  const [saving, setSaving] = useState(false)
  // Each time it opens or closes it starts over from the app as it is then (set while
  // rendering, so no frame shows what an earlier opening held).
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setTyped(typedOf(app))
    setTypedPaths(linkPathsOf(app).join('\n'))
    setProblems({})
    setAsking(null)
    setSaving(false)
  }
  const { reset } = update
  useEffect(() => {
    if (!open) {
      reset()
    }
  }, [open, reset])

  const identifier = identifierOf(app)
  const was = identityOf(app)

  function after(change: UpdateNativeAppRequest) {
    const appLinkPaths = change.appLinkPaths ?? was?.appLinkPaths ?? []
    if (was?.platform === 'ios') {
      return { ...was, teamId: change.teamId ?? was.teamId, appLinkPaths }
    }
    if (was?.platform === 'android') {
      return {
        ...was,
        sha256CertFingerprints: change.sha256CertFingerprints ?? was.sha256CertFingerprints,
        appLinkPaths,
      }
    }
    return null
  }

  function send(data: UpdateNativeAppRequest) {
    setSaving(true)
    update.mutate(
      { id: app.id, data },
      {
        onError: () => {
          setSaving(false)
          setAsking(null)
        },
        onSuccess: async () => {
          await refreshNativeApps(queryClient)
          notify('Native app saved')
          onClose()
        },
      }
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    update.reset()
    const whole = UpdateNativeAppRequestSchema.safeParse({
      ...(app.platform === 'ios'
        ? { teamId: typed.trim() }
        : { sha256CertFingerprints: dedupe(fingerprintsOf(typed)) }),
      appLinkPaths: pathsOf(typedPaths),
    })
    if (!whole.success) {
      setProblems(nativeAppProblems(whole.error.issues))
      return
    }
    // Only what differs is sent: a field that is as it was is not a change to record.
    const data: UpdateNativeAppRequest = {}
    if (was?.platform === 'ios' && whole.data.teamId !== was.teamId) {
      data.teamId = whole.data.teamId
    }
    if (
      was?.platform === 'android' &&
      normalizeCertFingerprints(whole.data.sha256CertFingerprints ?? []).join() !==
        normalizeCertFingerprints(was.sha256CertFingerprints).join()
    ) {
      data.sha256CertFingerprints = whole.data.sha256CertFingerprints
    }
    const paths = normalizeAppLinkPaths(whole.data.appLinkPaths ?? [])
    if (paths.join() !== normalizeAppLinkPaths(was?.appLinkPaths ?? []).join()) {
      data.appLinkPaths = paths
    }
    if (Object.keys(data).length === 0) {
      setProblems({
        general:
          app.platform === 'ios'
            ? 'Change the team or the link paths first.'
            : 'Change the fingerprints or the link paths first.',
      })
      return
    }
    setProblems({})
    if (wideningSentences(was, after(data)).length > 0) {
      setAsking(data)
      return
    }
    send(data)
  }

  if (asking !== null) {
    const next = after(asking)
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={wideningTitle(next ? nativeAppWeakenings(was, next) : [])}
        description={
          <>
            You are changing the {platformLabel(app.platform)} app{' '}
            <bdi className='font-mono break-all'>{identifier}</bdi>.
          </>
        }
      >
        <WeakeningQuestion
          sentences={wideningSentences(was, next)}
          requireText={environment.kind === 'production' ? identifier : undefined}
          pending={saving}
          confirmLabel='Save changes'
          onConfirm={() => send(asking)}
          onCancel={() => setAsking(null)}
        />
      </Modal>
    )
  }

  const shown = { ...serverProblems(update.error, 'change'), ...problems }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <>
          Edit <bdi className='font-mono break-all'>{identifier}</bdi>
        </>
      }
      description='The platform and the name are what the app is, and stay. The served file follows a change within five minutes; devices keep what they fetched for longer.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        {app.platform === 'ios' ? (
          <TextField
            label='Team ID'
            autoComplete='off'
            autoCapitalize='characters'
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            error={shown.teamId}
            hint={TEAM_HINT}
          />
        ) : (
          <FingerprintsField
            value={typed}
            onChange={setTyped}
            error={shown.sha256CertFingerprints}
          />
        )}
        {app.platform === 'ios' || app.platform === 'android' ? (
          <LinkPathsField
            platform={app.platform}
            value={typedPaths}
            onChange={setTypedPaths}
            error={shown.appLinkPaths}
          />
        ) : null}
        {shown.general ? (
          <p role='alert' className='text-sm text-destructive'>
            {shown.general}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={saving}>
            Save changes
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}
