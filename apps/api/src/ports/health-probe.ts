/** A dependency `/v1/ready` checks before the instance takes traffic. */
export interface HealthProbe {
  /** Stable name reported in the readiness response, e.g. `database`. */
  readonly name: string
  /**
   * Resolve when the dependency is usable; reject otherwise.
   *
   * @throws Whatever the dependency throws; the message is logged, never returned to clients.
   */
  check(): Promise<void>
}
