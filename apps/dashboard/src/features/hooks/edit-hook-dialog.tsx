import { useQueryClient } from '@tanstack/react-query'
import { type UpdateHookRequest, UpdateHookRequestSchema } from '@tula/contract'
import { type FormEvent, useEffect, useState } from 'react'
import { type Hook, useUpdateHook } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Modal } from '~/components/modal'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import {
  deadlineOf,
  HookFields,
  type HookFormValues,
  type HookProblems,
  hookProblems,
  serverProblems,
  WeakeningQuestion,
} from './hook-form'
import { refreshHooks } from './queries'
import { strengthOf, weakeningSentences } from './words'

function valuesOf(hook: Hook): HookFormValues {
  return { url: hook.url, deadline: String(hook.deadlineMs), failureMode: hook.failureMode }
}

/**
 * Change a hook's address, its deadline or what happens when a call fails. Only what changed
 * is sent: a field left alone keeps its value on the server, whatever it is by then. A
 * change to "let it through" is asked about first.
 *
 * @param props - `hook`: the hook as listed; `open` and `onClose`.
 * @returns The dialog.
 */
export function EditHookDialog({
  hook,
  open,
  onClose,
}: {
  hook: Hook
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const update = useUpdateHook({ request: useEnvironmentRequest() })
  const [values, setValues] = useState<HookFormValues>(() => valuesOf(hook))
  const [problems, setProblems] = useState<HookProblems>({})
  // The change as it will be sent, held while the operator is asked about it.
  const [asking, setAsking] = useState<UpdateHookRequest | null>(null)
  // From the click until the dialog closes, which is after the list was read again: the
  // request has succeeded before that, and a live button would send it a second time.
  const [saving, setSaving] = useState(false)
  // One dialog that is a form and then a question, so its state lives here and not in a
  // body that comes and goes. Each time it opens or closes it starts over from the hook as
  // it is then (set while rendering, so no frame shows what an earlier opening held).
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setValues(valuesOf(hook))
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

  function after(change: UpdateHookRequest) {
    return {
      ...strengthOf(hook),
      ...(change.failureMode ? { failureMode: change.failureMode } : {}),
    }
  }

  function send(data: UpdateHookRequest) {
    setSaving(true)
    update.mutate(
      { id: hook.id, data },
      {
        onError: () => {
          setSaving(false)
          setAsking(null)
        },
        onSuccess: async () => {
          await refreshHooks(queryClient)
          notify('Hook saved')
          onClose()
        },
      }
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const address = values.url.trim()
    const deadline = deadlineOf(values.deadline)
    const parsed = UpdateHookRequestSchema.safeParse({
      ...(address === hook.url ? {} : { url: address }),
      ...(deadline === hook.deadlineMs ? {} : { deadlineMs: deadline }),
      ...(values.failureMode === hook.failureMode ? {} : { failureMode: values.failureMode }),
    })
    if (!parsed.success) {
      update.reset()
      setProblems(hookProblems(parsed.error.issues, address))
      return
    }
    setProblems({})
    if (weakeningSentences(hook.point, strengthOf(hook), after(parsed.data)).length > 0) {
      update.reset()
      setAsking(parsed.data)
      return
    }
    send(parsed.data)
  }

  if (asking !== null) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title='Let it through when a call fails?'
        description={
          <>
            You are changing the hook for <code className='font-mono'>{hook.point}</code> to “let it
            through”.
          </>
        }
      >
        <WeakeningQuestion
          sentences={weakeningSentences(hook.point, strengthOf(hook), after(asking))}
          requireText={environment.kind === 'production' ? hook.point : undefined}
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
          Edit the hook for <code className='font-mono'>{hook.point}</code>
        </>
      }
      description='A new address is judged like a new hook’s. The signing secret stays the same.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <HookFields values={values} onChange={setValues} problems={shown} />
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
