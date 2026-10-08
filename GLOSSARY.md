# Tula Auth

Authentication and user management that an operator hosts themselves. This glossary fixes the
words whose meaning was decided on purpose; it is not a specification.

## Language

### Devices

**Device**:
A session bound to a key that its phone or computer holds and cannot export. A device does not outlive its session.
_Avoid_: Trusted device, registered device, device record

**Device binding**:
The tie between a session and its device's key, proven again each time the session is renewed.
_Avoid_: Device verification, device attestation

### Telling and asking an operator's backend

**Webhook**:
A signed notice, sent to an operator's endpoint, of something that has already happened. Its answer changes nothing.
_Avoid_: Callback, event hook

**Delivery**:
One event owed to one endpoint, from the moment it is queued until it is delivered or given up. One delivery can take several attempts.
_Avoid_: Message, dispatch, send

**Attempt**:
One request the server made for a delivery. What the server decided not to send is not an attempt.
_Avoid_: Try, retry (a retry is an attempt after the first)

**Test event**:
An example event an administrator asks the server to send to one endpoint, marked as a test inside its signed body. Nothing it describes happened.
_Avoid_: Ping, sample, dry run

**Hook**:
A signed question, sent to an operator's endpoint, whose answer decides what happens next: allow, deny, or claims to add.
_Avoid_: Webhook, plugin, callback

**JWT template**:
A named set of custom claims in an environment's settings, which a session profile chooses by name.
_Avoid_: Token template, claim mapping, session template

**Custom claim**:
A claim an operator's template adds to a session, always inside the one namespace claim `ext` and never a claim Tula sets itself.
_Avoid_: Private claim, extra claim, metadata

### Agents

**Proposal**:
A change an agent has asked for and that has not happened. It happens only when a human approves it.
_Avoid_: Pending write, request, draft
