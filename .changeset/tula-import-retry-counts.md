---
"@tula-tech/cli": patch
"@tula-tech/contract": minor
"@tula-tech/admin": minor
"@tula-tech/core": patch
---

`tula import` reports the users of a retried batch correctly. When a batch got no answer and was sent again, the users the first attempt had made were counted as skipped and a Clerk member was found by address. `POST /v1/admin/users/import` now answers a skipped `email_exists` row with the existing user's `id` and `sameExternalId` (whether their stored external id is the row's); `tula import` counts such a row in a retried batch as created and pairs Clerk members by the recorded id. The answer is additive.
