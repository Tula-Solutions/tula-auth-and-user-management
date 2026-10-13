import { SignUp } from '@tula-tech/nextjs'

export default function SignUpPage() {
  return <SignUp signInUrl='/sign-in' afterSignUpUrl='/dashboard' collectName />
}
