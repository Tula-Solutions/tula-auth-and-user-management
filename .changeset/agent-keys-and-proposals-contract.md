---
'@tula/contract': minor
---

Agent keys and proposals ([ADR 0051](../docs/adr/0051-proposals.md)): the key kind `agent`
(`tula_ak_…`, `AGENT_KEY_PREFIX`), the proposal's schemas and closed lists
(`PROPOSAL_OPERATIONS`, `PROPOSAL_OPERATION_TARGETS`, `PROPOSAL_STATUSES`,
`PROPOSAL_APPROVAL_REFUSALS`, `PROPOSAL_APPROVER_TYPES`, `proposalSummary`), the audit
target `proposal`, and four event types (`proposal.created`, `proposal.approved`,
`proposal.executed`, `proposal.failed`). `user.banned` may carry `proposalId` and
`approvedBy` when an agent's approved proposal carried it out. No new error code.
