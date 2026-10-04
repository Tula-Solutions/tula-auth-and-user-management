import { SignUp } from '@tula/nextjs'

export default function SignUpPage() {
  return <SignUp signInUrl='/sign-in' afterSignUpUrl='/dashboard' collectName />
}
