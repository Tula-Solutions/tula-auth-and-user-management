import type { ComponentProps } from 'react'

/** The test double of shadcn's `label` primitive. */
export function Label(props: ComponentProps<'label'>) {
  return <label data-slot='label' {...props} />
}
