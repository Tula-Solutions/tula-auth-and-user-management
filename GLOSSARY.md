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

**Hook**:
A signed question, sent to an operator's endpoint, whose answer decides what happens next: allow, deny, or claims to add.
_Avoid_: Webhook, plugin, callback

### Agents

**Proposal**:
A change an agent has asked for and that has not happened. It happens only when a human approves it.
_Avoid_: Pending write, request, draft
