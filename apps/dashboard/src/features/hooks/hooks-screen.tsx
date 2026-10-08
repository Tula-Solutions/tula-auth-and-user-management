import { HOOK_POINTS } from '@tula/contract'
import { type Hook, useListHooks } from '~/api/generated/api.gen'
import { PageHeader } from '~/components/page'
import { QueryState } from '~/components/states'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { HookCard } from './hook-card'

/**
 * The points of the list: the contract's three, always and in its order, each with its hook
 * or none; then whatever else the server lists (a point a later server knows, or a second
 * hook at a point, which no server of this version makes), so that nothing it holds is
 * hidden.
 *
 * @param hooks - The environment's hooks as the API lists them.
 * @returns One entry per card, with a key that is unique in the list.
 */
export function pointsOf(
  hooks: readonly Hook[]
): { key: string; point: string; hook: Hook | null }[] {
  const shown = new Set<string>()
  const known = HOOK_POINTS.map((point) => {
    const hook = hooks.find((entry) => entry.point === point) ?? null
    if (hook) {
      shown.add(hook.id)
    }
    return { key: point, point: point as string, hook }
  })
  const others = hooks
    .filter((hook) => !shown.has(hook.id))
    .map((hook) => ({ key: hook.id, point: hook.point, hook }))
  return [...known, ...others]
}

/**
 * The hooks of an environment: the questions the server asks a backend before it acts, one
 * per point.
 *
 * @returns The screen.
 */
export function HooksScreen() {
  const environment = useEnvironment()
  const hooks = useListHooks({ request: useEnvironmentRequest() })
  return (
    <>
      <PageHeader
        title='Hooks'
        description='A hook is a signed question the server asks your backend before it acts. The answer decides what happens next. Each point has at most one.'
      />
      <QueryState query={hooks} label='Loading hooks'>
        {(list) => (
          <ul className='grid gap-4'>
            {pointsOf(list.data).map(({ key, point, hook }) => (
              // The environment is part of the key: a card holds open dialogs and a form.
              <li key={`${environment.id}:${key}`}>
                <HookCard point={point} hook={hook} />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </>
  )
}
