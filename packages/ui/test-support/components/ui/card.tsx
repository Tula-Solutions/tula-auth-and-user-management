import type { ComponentProps } from 'react'

/** The test doubles of shadcn's `card` primitives: plain elements that keep their `data-slot`. */
export function Card(props: ComponentProps<'div'>) {
  return <div data-slot='card' {...props} />
}

export function CardHeader(props: ComponentProps<'div'>) {
  return <div data-slot='card-header' {...props} />
}

export function CardContent(props: ComponentProps<'div'>) {
  return <div data-slot='card-content' {...props} />
}

export function CardFooter(props: ComponentProps<'div'>) {
  return <div data-slot='card-footer' {...props} />
}
