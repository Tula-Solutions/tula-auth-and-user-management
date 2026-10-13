---
'@tula-tech/admin': minor
---

`createAgentClient` makes a client that holds an agent key (`tula_ak_…`): it reads what a
secret key reads and records proposals, and can change nothing. `createAdminClient`
refuses an agent key (`client.agent_key`) and `createAgentClient` refuses any other key
(`client.invalid_agent_key`). The generated operations gain the proposal routes
(`createProposal`, `listProposals`, `getProposal`, `approveProposal`).
