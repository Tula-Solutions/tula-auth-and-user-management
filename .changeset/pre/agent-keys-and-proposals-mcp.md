---
'@tula-tech/mcp': minor
---

The first propose tool, `propose_ban_user`: with an agent key the server can ask for a
user to be banned. It records a proposal and changes nothing; a person approves it
elsewhere, with a credential the server is not given. Propose tools reach the API through
a facade of their own (`ProposingAdmin`), beside the unchanged read-only one. The server
takes an `agent` client; with one, its reads go through it and it needs no secret key.
Agent keys are redacted from every result like secret keys.
