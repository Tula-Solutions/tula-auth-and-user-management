/** Source of new row ids (UUID v7 in production, sequential in tests). */
export interface IdGenerator {
  /** A new, unique UUID. */
  next(): string
}
