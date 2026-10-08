import { useQueryClient } from '@tanstack/react-query'
import { FileCog, TriangleAlert } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { fieldErrorMap, messageFor, toApiError } from '~/api/errors'
import {
  type EnvironmentSettingsInput,
  type EnvironmentSettingsState,
  getGetEnvironmentSettingsQueryKey,
  useGetEnvironmentSettings,
  useReplaceEnvironmentSettings,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { PageHeader } from '~/components/page'
import { QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { useScope } from '~/state/scope'
import {
  classifyFailure,
  confirmationTitle,
  describeWeakening,
  etag,
  planSave,
  type SavePlan,
  type SettingsDocument,
} from './model'

/** What a settings screen gets to draw and change the draft. */
export interface SettingsEditor {
  /** The settings as edited so far. */
  draft: SettingsDocument
  /** Change the draft. */
  update: (change: (draft: SettingsDocument) => SettingsDocument) => void
  /** The server's field errors of the last refused save, by field path. */
  errors: Record<string, string>
}

/** A settings document, its draft, and the environment both were loaded for. */
interface LoadedSettings {
  environmentId: string
  base: EnvironmentSettingsState
  draft: SettingsDocument
}

/**
 * The one save model of every settings screen.
 *
 * Load the document with its revision; edit a draft; replace the whole document with
 * `If-Match: "<revision>"`. A stale revision (412) is shown as "changed elsewhere" with a
 * reload, never retried over the other writer's change. A save that weakens security, or
 * that changes settings a config file manages, asks first.
 *
 * The document and its draft belong to the environment they were loaded for: shown for
 * another one they are dropped and loaded again, and a save is refused when the selection
 * (where the request would go) is no longer that environment.
 *
 * @returns The state and the actions the frame draws.
 */
export function useSettingsEditor() {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  // Keyed by the environment as well as the path: an answer in the cache is then known to
  // be this environment's, whatever was on the screen before.
  const queryKey = [...getGetEnvironmentSettingsQueryKey(), environment.id] as const
  const query = useGetEnvironmentSettings({ query: { queryKey }, request: useEnvironmentRequest() })
  const [loaded, setLoaded] = useState<LoadedSettings | null>(null)
  const [conflict, setConflict] = useState(false)
  const [confirming, setConfirming] = useState<SavePlan | null>(null)
  // A document loaded for another environment is not this one's: it is neither drawn nor
  // sent. The screens are remounted on a switch (`EnvironmentGate`); this holds without it.
  const current = loaded !== null && loaded.environmentId === environment.id ? loaded : null
  const base = current?.base ?? null
  const draft = current?.draft ?? null
  const replace = useReplaceEnvironmentSettings({
    request: useEnvironmentRequest({ headers: { 'If-Match': etag(base?.revision ?? 0) } }),
  })

  function adopt(state: EnvironmentSettingsState) {
    setLoaded({ environmentId: environment.id, base: state, draft: state.settings })
  }

  // The first answer becomes the base. A later one (a refetch) is adopted only through
  // `reload`, so a background refresh never throws away what the operator is typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `adopt` only closes over the environment id, which is listed.
  useEffect(() => {
    if (query.data && current === null) {
      adopt(query.data)
    }
  }, [query.data, current, environment.id])

  /** Whether a request made now would go to the environment the document was loaded for. */
  function stillHere(): boolean {
    return current !== null && useScope.getState().environmentId === current.environmentId
  }

  const plan = base && draft ? planSave(base.settings, draft, base.managedBy) : null

  function send() {
    setConfirming(null)
    // The request names this screen's environment and `dashboardFetch` refuses it once the
    // selection has moved on; checked here as well, so that nothing is even attempted.
    if (draft === null || !stillHere()) {
      return
    }
    replace.mutate(
      { data: draft as EnvironmentSettingsInput },
      {
        onSuccess: (state) => {
          queryClient.setQueryData(queryKey, state)
          adopt(state)
          setConflict(false)
          notify('Settings saved')
        },
        onError: (error) => setConflict(classifyFailure(error) === 'conflict'),
      }
    )
  }

  return {
    query,
    base,
    draft,
    plan,
    conflict,
    confirming,
    saving: replace.isPending,
    error: conflict ? null : replace.error,
    update: (change: (current: SettingsDocument) => SettingsDocument) =>
      setLoaded((held) =>
        held === null || held.environmentId !== environment.id
          ? held
          : { ...held, draft: change(held.draft) }
      ),
    save: () => {
      if (plan === null || !plan.dirty || replace.isPending || !stillHere()) {
        return
      }
      if (plan.needsConfirmation) {
        setConfirming(plan)
      } else {
        send()
      }
    },
    confirm: send,
    cancelConfirmation: () => setConfirming(null),
    discard: () => {
      replace.reset()
      setLoaded((held) => (held === null ? held : { ...held, draft: held.base.settings }))
    },
    reload: async () => {
      replace.reset()
      const fresh = await query.refetch()
      if (fresh.data) {
        adopt(fresh.data)
        setConflict(false)
      }
    },
  }
}

/**
 * The banner of settings that a config file manages (`tula apply`, ADR 0030), and the notice
 * that they have drifted from it.
 *
 * @param props - `managedBy`: the loaded state's record.
 * @returns The banner, or nothing for settings nobody manages.
 */
export function ManagedBanner({ managedBy }: { managedBy: EnvironmentSettingsState['managedBy'] }) {
  if (managedBy === null) {
    return null
  }
  return (
    <div
      className='flex flex-col gap-2 rounded-lg border border-input bg-card p-4 text-sm'
      role='note'
    >
      <p className='flex items-center gap-2 font-semibold'>
        <FileCog aria-hidden='true' className='size-4' />
        Managed by {managedBy.tool === 'tula-apply' ? 'tula apply' : managedBy.tool}
      </p>
      <p>
        These settings come from a config file. Changes made here will be reported as drift, and the
        next <code>tula apply</code> puts the file’s values back.
      </p>
      {managedBy.drifted ? (
        <p className='flex items-center gap-2 font-medium text-destructive'>
          <TriangleAlert aria-hidden='true' className='size-4' />
          Drift: these settings were changed outside the config file since it was last applied.
        </p>
      ) : null}
    </div>
  )
}

/** Props of {@link SettingsFrame}. */
export interface SettingsFrameProps {
  title: string
  description: ReactNode
  /** Draws the screen's sections from the draft. */
  children: (editor: SettingsEditor) => ReactNode
  /** Content under the form that has its own save (OAuth providers). */
  after?: ReactNode
}

/**
 * The frame every settings screen shares: the heading, the managed-by banner, the form with
 * its save bar, the "changed elsewhere" notice and the confirmation before a weaker policy.
 *
 * @param props - See {@link SettingsFrameProps}.
 * @returns The screen.
 */
export function SettingsFrame({ title, description, children, after }: SettingsFrameProps) {
  const editor = useSettingsEditor()
  const errors = fieldErrorMap(editor.error)
  const failure = editor.error ? toApiError(editor.error) : null

  function submit(event: FormEvent) {
    event.preventDefault()
    editor.save()
  }

  return (
    <>
      <PageHeader title={title} description={description} />
      <QueryState query={editor.query} label='Loading settings'>
        {() =>
          editor.base && editor.draft ? (
            <>
              <ManagedBanner managedBy={editor.base.managedBy} />
              {editor.conflict ? (
                <div
                  role='alert'
                  className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive bg-destructive-surface p-4 text-sm'
                >
                  <p>
                    <span className='font-semibold'>Changed elsewhere.</span> These settings were
                    saved by someone else (or by <code>tula apply</code>) after you opened them, so
                    your changes were not saved. Reload to see the current version, then make your
                    changes again.
                  </p>
                  <ActionButton variant='outline' size='sm' onClick={() => void editor.reload()}>
                    Reload settings
                  </ActionButton>
                </div>
              ) : null}
              <form onSubmit={submit} className='flex flex-col gap-6' noValidate>
                {children({ draft: editor.draft, update: editor.update, errors })}
                {failure ? (
                  <div
                    role='alert'
                    className='flex flex-col gap-1 rounded-lg border border-destructive bg-destructive-surface p-4 text-sm'
                  >
                    <p className='font-semibold'>These settings were not saved.</p>
                    {failure.fieldErrors.length > 0 ? (
                      <ul className='list-disc pl-5'>
                        {failure.fieldErrors.map((entry) => (
                          <li key={`${entry.field}:${entry.message}`}>
                            <code className='text-xs'>{entry.field}</code>: {entry.message}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>{messageFor(failure)}</p>
                    )}
                  </div>
                ) : null}
                <div className='sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t bg-background px-1 py-3'>
                  <ActionButton
                    type='submit'
                    pending={editor.saving}
                    aria-disabled={!editor.plan?.dirty || editor.saving || undefined}
                  >
                    {editor.saving ? 'Saving…' : 'Save changes'}
                  </ActionButton>
                  <ActionButton
                    variant='outline'
                    onClick={editor.discard}
                    aria-disabled={!editor.plan?.dirty || undefined}
                  >
                    Discard changes
                  </ActionButton>
                  <p className='text-sm text-muted-foreground' role='status'>
                    {editor.plan?.dirty ? 'You have unsaved changes.' : 'No unsaved changes.'}
                  </p>
                </div>
              </form>
              <ConfirmDialog
                open={editor.confirming !== null}
                title={confirmationTitle(editor.confirming?.weakenings ?? [])}
                confirmLabel='Save anyway'
                destructive
                onConfirm={editor.confirm}
                onCancel={editor.cancelConfirmation}
              >
                {editor.confirming && editor.confirming.weakenings.length > 0 ? (
                  <>
                    <span className='block'>Compared with what is saved now:</span>
                    <span className='mt-1 block'>
                      {editor.confirming.weakenings.map((path) => (
                        <span key={path} className='block'>
                          • {describeWeakening(path)}
                        </span>
                      ))}
                    </span>
                  </>
                ) : null}
                {editor.confirming?.managedBy ? (
                  <span className='mt-2 block'>
                    These settings are managed by a config file. This change will be reported as
                    drift and undone by the next <code>tula apply</code>.
                  </span>
                ) : null}
              </ConfirmDialog>
            </>
          ) : null
        }
      </QueryState>
      {after}
    </>
  )
}
