import { UserProfile } from '@tula/nextjs'

/** The account page. The proxy protects it; the component talks to the API from the browser. */
export default function ProfilePage() {
  return <UserProfile afterSignOutUrl='/' />
}
