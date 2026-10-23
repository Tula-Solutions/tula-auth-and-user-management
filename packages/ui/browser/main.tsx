import { TulaProvider } from '@tula-tech/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OrganizationProfile } from '@/components/tula/organization-profile'
import { OrganizationSwitcher } from '@/components/tula/organization-switcher'
import './styles.css'

// The page `e2e/tests/tula-ui.spec.ts` opens (see vite.config.ts). The signed-in user comes from
// the session cookie the test's sign-up left for the API's origin; nothing here signs anyone in.

const API_URL: string = import.meta.env.VITE_TULA_API_URL ?? 'http://localhost:3003'
const PUBLISHABLE_KEY: string = import.meta.env.VITE_TULA_PUBLISHABLE_KEY ?? ''

/** The two organization items, each under a heading of its own, inside one provider. */
function Harness() {
  return (
    <TulaProvider publishableKey={PUBLISHABLE_KEY} baseUrl={API_URL}>
      <main className='mx-auto grid max-w-2xl gap-10 p-6'>
        <h1 className='text-2xl font-semibold'>Tula UI items</h1>
        <section aria-labelledby='switcher-title' className='grid gap-3'>
          <h2 id='switcher-title' className='text-lg font-medium'>
            Organization switcher
          </h2>
          <OrganizationSwitcher allowCreate />
        </section>
        <section aria-labelledby='profile-title' className='grid gap-3'>
          <h2 id='profile-title' className='text-lg font-medium'>
            Organization profile
          </h2>
          <OrganizationProfile headingLevel={3} />
        </section>
      </main>
    </TulaProvider>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Harness />
    </StrictMode>
  )
}
