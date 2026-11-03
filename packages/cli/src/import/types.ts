import type { FirebaseScryptParams, ImportUserRow } from '@tula-tech/contract'

/**
 * The providers `tula import --from` reads, each by one parser.
 *
 * @example
 * ```ts
 * const provider: ImportProvider = 'supabase'
 * ```
 */
export const IMPORT_PROVIDERS = ['clerk', 'auth0', 'firebase', 'supabase', 'better-auth'] as const

/** One of {@link IMPORT_PROVIDERS}. */
export type ImportProvider = (typeof IMPORT_PROVIDERS)[number]

/**
 * Why a row is not imported: a code (the contract's `import.*` / `email.invalid` where one
 * fits, otherwise `source.*`, which only this command uses) and a fixed sentence written by this
 * CLI. A reason never repeats a value from the export: not an address, not a hash.
 *
 * @example
 * ```ts
 * const refusal: Refusal = { code: 'email.invalid', reason: 'The row has no email address.' }
 * ```
 */
export interface Refusal {
  /** A stable, dot-namespaced code. */
  code: string
  /** One fixed sentence. */
  reason: string
}

/**
 * One user of an export, after parsing. `row` counts the users of the file from 1 (the Nth
 * record of the JSON array, the Nth line of the NDJSON, the Nth data row of the CSV), which is
 * how a person finds it.
 *
 * @example
 * ```ts
 * const source: SourceRow = { row: 1, sourceId: 'user_1', email: 'maya@northline.app', user, refusal: null }
 * ```
 */
export interface SourceRow {
  /** The user's place in the file, from 1. */
  row: number
  /** The user's id at the provider, when the export has one. */
  sourceId?: string | undefined
  /**
   * The address as the export has it, kept only to mask it in a report and to find repeats. It
   * is never written to the progress file and never printed whole.
   */
  email: string | null
  /** The row to send; `null` when {@link SourceRow.refusal} says why not. */
  user: ImportUserRow | null
  /** Why the row is not sent; `null` for a row that is. */
  refusal: Refusal | null
}

/** An organization of a Clerk export. */
export interface SourceOrganization {
  /** Its place among the organizations of the file, from 1. */
  row: number
  /** Its id at the provider. */
  sourceId: string
  /** The organization's name, as the API takes it; `null` when {@link SourceOrganization.refusal} is set. */
  name: string | null
  /** The organization's slug in Tula's form; `null` when refused. */
  slug: string | null
  /** Why it is not created; `null` for one that is. */
  refusal: Refusal | null
}

/** A membership of a Clerk export. */
export interface SourceMembership {
  /** Its place among the memberships of the file, from 1. */
  row: number
  /** The organization's id at the provider. */
  organizationId: string
  /** The user's id at the provider. */
  userId: string
  /** The Tula role key; `null` when {@link SourceMembership.refusal} is set. */
  role: string | null
  /** Why it is not added; `null` for one that is. */
  refusal: Refusal | null
}

/**
 * What a parser reads from an export. Parsing makes no network call: the provider's own export
 * is all there is.
 *
 * @example
 * ```ts
 * const parsed: ParsedExport = parseSupabase({ text, files: {}, allowPasswordless: false })
 * ```
 */
export interface ParsedExport {
  /** One entry per user, in file order. */
  rows: SourceRow[]
  /** Firebase's project parameters, sent once per call with the rows that need them. */
  firebaseScrypt?: FirebaseScryptParams | undefined
  /** Organizations (Clerk only). */
  organizations: SourceOrganization[]
  /** Memberships (Clerk only). */
  memberships: SourceMembership[]
  /** Fixed sentences about the export as a whole: what is not carried over, what was dropped. */
  notes: string[]
}

/** What a parser is given. */
export interface ParseInput {
  /** The main export file's text. */
  text: string
  /** The other files, by option name (`password-hashes`, `accounts`, `organizations`, `memberships`). */
  files: Readonly<Record<string, string | undefined>>
  /**
   * Import a row whose password hash cannot be carried over (an algorithm the server does not
   * read) without a password, instead of refusing it.
   */
  allowPasswordless: boolean
  /** Firebase's hash parameters, already read from their file (Firebase only). */
  firebase?: FirebaseScryptParams | undefined
}

/** A parser: pure, local, synchronous. */
export type Parser = (input: ParseInput) => ParsedExport
