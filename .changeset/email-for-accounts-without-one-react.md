---
'@tula/react': minor
---

`<UserProfile>` has an "Email address" section for an account that has none (one made with
X or Facebook): the user types an address, is emailed a code and confirms it (ADR 0059). A
user with nothing to step up with is told to sign out and sign in again. An account that
has an address shows no such section: nothing here changes one. Ten strings are new under
`emailAddress` in the localization.
