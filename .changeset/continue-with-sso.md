---
"@tula-tech/core": minor
"@tula-tech/react": minor
"@tula-tech/nextjs": patch
---

Continue with SSO in `<SignIn>` (TULA-141). `@tula-tech/core` gains `flow.startSso({ redirectUrl })` on a sign-in: it starts the `sso` first factor, keeps the binding in the tab's session storage and navigates to the identity provider, and `signIn.handleOAuthCallback()` finishes the return. `<SignIn>` draws "Continue with SSO" when a step offers `sso` (alone, with no password field, when it is the only strategy, and among the other ways beside a password); `useSignIn()` gains `startSso`. New words `signIn.sso` and `signIn.ssoPrompt`. `@tula-tech/nextjs` is unchanged in code: its same-origin handler and callback page already complete the round (a browser test proves it).
