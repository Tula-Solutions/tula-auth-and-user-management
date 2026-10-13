---
'@tula-tech/core': minor
---

`client.user.email.request({ email })` and `client.user.email.verify({ code })`: a signed-in
user whose account has no email address (one made with X or Facebook) asks for a code at an
address and proves it (ADR 0059). Both need a recent sign-in; an account with nothing to
step up with is answered `auth.step_up_required` with no method and signs in again. An
address another account holds is answered like a free one and no code confirms it. The
message table gains `email.already_set`.
