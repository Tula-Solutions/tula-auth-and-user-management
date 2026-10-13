/**
 * Remembers the unique id of every device-binding proof that was accepted, for as long as a
 * proof with its nonce could be accepted again (ADR 0043). A proof whose id is already
 * remembered is a replay.
 *
 * In process memory for one instance, in Redis when several must agree (ADR 0016). An adapter
 * whose storage is unreachable throws `service.unavailable`: a proof is not accepted while
 * nobody can say whether it was used before, and nothing falls back to process memory.
 */
export interface ProofReplayGuard {
  /**
   * Remember an id unless it is remembered already, in **one atomic step**: of several calls
   * with one id, on any number of instances sharing the storage, exactly one is told `true`.
   *
   * @param id - What identifies the proof: a hash, never anything a client sent as it came.
   * @param until - When a proof with this id can no longer be accepted; the entry may be
   *   dropped then.
   * @returns `true` when the id was not remembered and now is; `false` for a replay.
   */
  remember(id: string, until: Date): Promise<boolean>
}
