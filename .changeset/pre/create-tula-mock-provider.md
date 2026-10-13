---
'create-tula': patch
---

A scaffolded project can try the provider buttons before it has real credentials: its Compose
file passes `OAUTH_MOCK_PROVIDER` from `.env` to the API (off unless set; the API refuses it
outside `ENVIRONMENT=local`), and `.env.example` documents the switch.
