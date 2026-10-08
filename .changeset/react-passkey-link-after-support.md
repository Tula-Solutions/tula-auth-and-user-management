---
'@tula/react': patch
---

`<SignIn>`: "Sign in with a passkey" is listed among the other ways to sign in only once the
browser is known to have WebAuthn.

After an address, where the server offered a passkey next to another method, the link was
drawn before the browser had been asked and taken away one render later in a browser without
WebAuthn: a control that showed and could not work. It now arrives with the answer, as it
already did on the second-factor and step-up screens. A sign-in whose only method is a passkey
is unchanged: it does not open on "not supported" before the browser has been asked.
