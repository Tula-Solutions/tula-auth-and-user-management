import { SignIn } from '@tula-tech/react'
import { passwordSignInSuite } from '../test-support/sign-in.suite'

// The prebuilt `<SignIn>` is the reference behaviour of the registry's sign-in: the same suite
// runs against both (the registry's is in `items/sign-in.test.tsx`).
passwordSignInSuite('the prebuilt <SignIn>', ({ onComplete }) => <SignIn onComplete={onComplete} />)
