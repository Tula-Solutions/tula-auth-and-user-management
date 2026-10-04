import { CircleCheck } from 'lucide-react'
import { useEffect } from 'react'
import { create } from 'zustand'

interface Toast {
  id: number
  message: string
}

interface ToastState {
  toasts: Toast[]
  next: number
  push: (message: string) => void
  dismiss: (id: number) => void
}

const useToasts = create<ToastState>((set) => ({
  toasts: [],
  next: 1,
  push: (message) =>
    set((state) => ({
      toasts: [...state.toasts, { id: state.next, message }],
      next: state.next + 1,
    })),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}))

/** How long a confirmation stays on screen. */
const TOAST_MS = 5000

/**
 * Say that something was done ("User banned").
 *
 * Only ever a fixed sentence of the dashboard: never a key, a token or anything a server sent.
 *
 * @param message - The sentence.
 */
export function notify(message: string): void {
  useToasts.getState().push(message)
}

/** Take every confirmation off the screen (a sign-out, or the start of a test). */
export function clearToasts(): void {
  useToasts.setState({ toasts: [] })
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToasts((state) => state.dismiss)
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast.id, dismiss])
  return (
    <li className='flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm text-card-foreground shadow-lg'>
      <CircleCheck aria-hidden='true' className='size-4 text-success' />
      {toast.message}
    </li>
  )
}

/**
 * The region confirmations appear in. A polite live region, so a screen reader announces
 * them without taking focus; written here rather than taken from a toast library because
 * those inject a `<style>` element, which the dashboard's Content-Security-Policy refuses.
 *
 * @returns The live region.
 */
export function Toaster() {
  const toasts = useToasts((state) => state.toasts)
  return (
    <div
      role='status'
      aria-live='polite'
      className='pointer-events-none fixed right-4 bottom-4 z-50 max-w-sm'
    >
      <ul className='flex flex-col gap-2'>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </ul>
    </div>
  )
}
