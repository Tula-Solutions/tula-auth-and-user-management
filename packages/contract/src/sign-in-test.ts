import * as z from 'zod'
import { ErrorCodeSchema } from './errors'
import {
  SIGN_IN_TEST_CLEANUPS,
  SIGN_IN_TEST_OUTCOMES,
  SIGN_IN_TEST_REASONS,
  SIGN_IN_TEST_STEP_OUTCOMES,
  SIGN_IN_TEST_STEPS,
} from './test-address'

/**
 * One step of a sign-in test's report: which step, what became of it and how long it took.
 * Closed words and a number; never an address, a code, a token or any text of a message.
 *
 * `code` is the API's error code of a step that failed with one. `reason` is one of the
 * server's fixed words: why a step was not run, or why it failed where no code says it.
 */
export const SignInTestStepResultSchema = z
  .strictObject({
    step: z.enum(SIGN_IN_TEST_STEPS),
    outcome: z.enum(SIGN_IN_TEST_STEP_OUTCOMES),
    /** Milliseconds the step took; 0 for a step that was not run. */
    durationMs: z.number().int().min(0),
    code: ErrorCodeSchema.optional(),
    reason: z.enum(SIGN_IN_TEST_REASONS).optional(),
  })
  .meta({ ref: 'SignInTestStepResult' })

/**
 * The report of a sign-in test (ADR 0058): what `POST /v1/agent/sign-in-tests` answers.
 *
 * A throwaway user was signed up and in through the environment's real flow, by the server
 * itself, and deleted. The report holds **nothing the flow handled**: no address, code,
 * password, attempt secret or token. `userId` is the id the server gave the throwaway user
 * (`null` when no account was made), there so that an operator can find the run's audit
 * entries; the user itself is gone unless `cleanup` is `failed`.
 */
export const SignInTestReportSchema = z
  .strictObject({
    outcome: z.enum(SIGN_IN_TEST_OUTCOMES),
    /** Every step of {@link SIGN_IN_TEST_STEPS}, in order, each once. */
    steps: z.array(SignInTestStepResultSchema).length(SIGN_IN_TEST_STEPS.length),
    userId: z.uuid().nullable(),
    cleanup: z.enum(SIGN_IN_TEST_CLEANUPS),
  })
  .meta({ ref: 'SignInTestReport' })

/** One step of a sign-in test's report. */
export type SignInTestStepResult = z.infer<typeof SignInTestStepResultSchema>
/** The report of a sign-in test. */
export type SignInTestReport = z.infer<typeof SignInTestReportSchema>
