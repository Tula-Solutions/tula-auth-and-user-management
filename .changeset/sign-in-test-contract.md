---
'@tula/contract': minor
---

A sign-in test ([ADR 0058](../docs/adr/0058-test-signin.md)): the setting
`agents.testSignIn` (`true`, `false` or `null`, the default: on in a development
environment, off in a production one; writing `true` is a weakening), `testSignInAllowed`,
the report's schema (`SignInTestReportSchema`) and its closed lists, the reserved address
of a throwaway user (`testAddress`, `isTestAddress`, `TEST_ADDRESS_DOMAIN`), the activity
types `sign_in_test.started` and `sign_in_test.finished`, and an optional `test: true` on
`user.created`. An address in the reserved domain is no longer accepted as a person's.
