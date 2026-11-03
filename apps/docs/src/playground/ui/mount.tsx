import { createRoot } from 'react-dom/client'
import { Playground } from './playground'

/**
 * Mount a playground into its placeholder. Called once per placeholder, by the entry, when the
 * placeholder is near the viewport: this module (React, the client, the components, the
 * sandbox) is not downloaded before that.
 *
 * @param host - The `[data-playground]` element the build wrote.
 */
export function mount(host: HTMLElement): void {
  const preset = host.dataset.preset ?? 'full'
  host.replaceChildren()
  createRoot(host).render(<Playground preset={preset} />)
  host.dataset.state = 'ready'
}
