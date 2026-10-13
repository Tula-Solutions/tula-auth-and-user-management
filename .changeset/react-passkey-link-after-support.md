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

The trade-off, chosen on purpose: the browser is asked after mount, so in a browser that has
WebAuthn the link is drawn one frame after the rest of the screen, and where it is the only
other way the whole "Other ways to sign in" list arrives with it (a small layout shift, and
the list joins the page after the title has taken the focus). A link that appears a frame late
was preferred to one that is shown and then removed.
