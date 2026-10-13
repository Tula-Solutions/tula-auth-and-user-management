---
'@tula/cli': minor
---

`tula diff` says how many accounts could not sign in without a provider the plan switches
off or removes ("at least" when the server did not look at every account), and lists it as
a weakening: `tula apply --yes` refuses such a plan without `--allow-weaker`, before any
write (ADR 0059). A server that does not answer the count is planned as before.
