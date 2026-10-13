---
'create-tula': patch
---

The scaffolded Compose file and `.env.example` pass `SMS_PROVIDER` and the six `TWILIO_*`
variables to the API, so that a scaffolded deployment can send text messages through Twilio
by setting them. Nothing is sent by default (`SMS_PROVIDER` stays `none`).
