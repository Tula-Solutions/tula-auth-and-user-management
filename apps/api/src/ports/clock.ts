/** Source of the current time. Services read time only through this, so tests control it. */
export interface Clock {
  /** The current instant. */
  now(): Date
}
