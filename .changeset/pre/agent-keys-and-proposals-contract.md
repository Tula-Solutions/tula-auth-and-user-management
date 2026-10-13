---
'@tula-tech/contract': minor
---

Agent keys and proposals ([ADR 0053](../docs/adr/0053-proposals.md)): the key kind `agent`
(`tula_ak_…`, `AGENT_KEY_PREFIX`), the proposal's schemas and closed lists
(`PROPOSAL_OPERATIONS`, `PROPOSAL_OPERATION_TARGETS`, `PROPOSAL_STATUSES`,
`PROPOSAL_APPROVAL_REFUSALS`, `PROPOSAL_FAILURE_REASONS`, `PROPOSAL_EXPIRY_REASONS`,
`PROPOSAL_APPROVER_TYPES`, `proposalSummary`), the audit
target `proposal`, and four event types (`proposal.created`, `proposal.approved`,
`proposal.executed`, `proposal.failed`). `user.banned` may carry `proposalId` and
`approvedBy` when an agent's approved proposal carried it out, both or neither. A
proposal whose agent key was revoked reads as `expired` with `expiryReason:
'agent_key_revoked'`. No new error code.
