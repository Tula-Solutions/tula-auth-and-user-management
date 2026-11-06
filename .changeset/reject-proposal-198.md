---
"@tula-tech/contract": minor
"@tula-tech/admin": minor
"@tula-tech/core": patch
"@tula-tech/cli": patch
---

A person can reject a pending agent proposal: `POST /v1/admin/proposals/:id/reject` (an optional short reason) moves it to the terminal `rejected` status, which the agent reads on its routes. `tula approve` names the new status.
