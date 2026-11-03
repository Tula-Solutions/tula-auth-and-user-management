import Link from 'next/link'
import { TeamSwitcher } from './team-switcher'

/** The prebuilt organization switcher. The proxy protects it like every page but the public ones. */
export default function Team() {
  return (
    <section className='panel' aria-labelledby='team-title'>
      <h1 id='team-title'>Your teams</h1>
      <TeamSwitcher />
      <p className='row'>
        <Link href='/dashboard' className='button-link quiet'>
          Back to the dashboard
        </Link>
      </p>
    </section>
  )
}
