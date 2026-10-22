import type { ComponentProps } from 'react'

/** The test double of shadcn's `input` primitive. */
export function Input(props: ComponentProps<'input'>) {
  return <input data-slot='input' {...props} />
}
