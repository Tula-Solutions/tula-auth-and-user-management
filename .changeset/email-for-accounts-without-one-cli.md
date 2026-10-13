---
'@tula/cli': minor
---

`tula diff` says how many accounts could not sign in without a provider the plan switches
off or removes ("at least" when the server did not look at every account), and lists it as
a weakening: `tula apply --yes` refuses such a plan without `--allow-weaker`, before any
write (ADR 0059). A server from before the count (it answers 404 or 405) is planned as
before. A count that could not be read for any other reason (a refusal, a limit, a failure,
no answer) flags the plan too: `tula apply --yes` is not let through by a request that
failed, and the diff says the count could not be read.
