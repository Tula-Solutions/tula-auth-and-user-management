/**
 * Caps how many audit-log exports one environment may have streaming at once, across every API
 * instance (ADR 0016). A slot is a lease with an expiry, so a process that dies mid-export does
 * not hold its slot for ever.
 *
 * In process memory for one instance, in Redis when several must agree. An adapter whose storage
 * is unreachable throws `service.unavailable`: an export is not started while nobody can say how
 * many are running, and nothing falls back to process memory.
 */
export interface ExportLeases {
  /**
   * Take a slot unless `limit` leases of the environment are live, in **one atomic step**: of
   * several calls at the limit's edge, on any number of instances, exactly the free slots win.
   *
   * @param environmentId - The environment; the only thing the storage learns about the export.
   * @param limit - How many leases may be live at once.
   * @param ttlMs - How long the lease lives unless {@link ExportLeases.renew}ed.
   * @returns The lease's id, or `null` when the environment is at its limit.
   */
  acquire(environmentId: string, limit: number, ttlMs: number): Promise<string | null>

  /**
   * Push a live lease's expiry `ttlMs` ahead, for an export that outlasts its first lease.
   *
   * @param environmentId - The environment the lease was taken for.
   * @param leaseId - What {@link ExportLeases.acquire} returned.
   * @param ttlMs - The new lifetime, counted from now.
   * @returns `false` when the lease had expired or was released (the slot may be another's now).
   */
  renew(environmentId: string, leaseId: string, ttlMs: number): Promise<boolean>

  /**
   * Give a slot back. Releasing an unknown or expired lease does nothing.
   *
   * @param environmentId - The environment the lease was taken for.
   * @param leaseId - What {@link ExportLeases.acquire} returned.
   */
  release(environmentId: string, leaseId: string): Promise<void>
}
