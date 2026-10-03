---
'@tula/contract': minor
'@tula/core': patch
'@tula/react': minor
---

First prerelease of the React SDK.

- `@tula/react`: `TulaProvider`, the hooks (`useAuth`, `useUser`, `useSession`, `useSignIn`,
  `useSignUp`, `useResetPassword`, `usePasswordChecklist`, `useClientConfig`, `useTula`),
  `SignedIn` / `SignedOut` / `TulaLoading`, and the prebuilt `SignIn` (with forgotten
  password), `SignUp`, `UserButton` and `UserProfile`, with one themeable stylesheet
  (`@tula/react/styles.css`), an `appearance` prop and a typed localization table.
- `@tula/contract`: a Zod-free `/theme` entry point: the theme tokens shared by every front
  end, their light and dark defaults, `themeToCssVariables`, `isValidThemeValue` (theme values
  are validated against a strict grammar and dropped when they do not match) and
  `contrastRatio`.
- `@tula/core`: a tab waiting for the cross-tab lock now waits for as long as a refresh can
  take with its one retry, so an app with a small `timeoutMs` no longer has two tabs refresh at
  once; `user.get()` no longer installs a user fetched for an earlier session; and a 204's
  empty body is read, so browsers stop listing successful sign-outs as cancelled requests.
