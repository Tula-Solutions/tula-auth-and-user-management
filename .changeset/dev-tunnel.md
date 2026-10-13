---
'@tula/cli': minor
'create-tula': patch
---

`tula dev --tunnel` starts the local stack under a public https address (this machine's
Tailscale Funnel name), so that a phone can reach it. The address is written into the
command's own block of `.env.local`; the settings that name it are printed, not written;
and the run refuses to start beside the mock provider or the development SMS inbox, which
the API serves on a loopback address only. `tula dev down`, and `tula dev` without the
flag, close the tunnel again, and so does a run that fails or is interrupted (Ctrl-C);
where the tunnel is opened is recorded in the block before it is opened, so a run that
was killed outright can still be closed by `tula dev down`. The scaffolded Compose file reads the API's `PUBLIC_URL`
from `TULA_PUBLIC_URL`, which only that command sets.
