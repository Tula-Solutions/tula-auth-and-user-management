---
"@tula-tech/core": patch
"@tula-tech/react": patch
---

A browser client's explicit `refresh()` while its sign-out request is in flight no longer brings the session back. `useStepUp` and the step-up dialog give up when the session changed during the prompt, a failed sign-out's dialog closes when someone signs in again, and a sign-in that is reset while it starts is discarded. A router and a link get the normalised destination, not the string as written. Leaving or deleting an organization picks the next one from the reloaded list.
