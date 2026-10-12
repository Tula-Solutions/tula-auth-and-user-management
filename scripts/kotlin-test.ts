import { join } from 'node:path'

// Runs the Kotlin SDK's Gradle build with the real API beside it (ADR 0054):
//
//   bun run native:kotlin:test                 # ./gradlew :tula-auth:check
//   bun run native:kotlin:test -- :tula-auth:test --tests '*JourneysTest*'
//
// It starts `e2e/kotlin-fixture.ts` on a free loopback port, hands its address to Gradle as
// TULA_FIXTURE_URL, and stops the fixture whatever Gradle's outcome. Needs a JDK (17 or
// later) on the PATH; the Gradle wrapper downloads the pinned Gradle and dependencies.

const ROOT = join(import.meta.dir, '..')
const ANDROID = join(ROOT, 'native', 'android')

/** How long the fixture has to say where it listens. It loads the whole API first. */
const FIXTURE_START_MS = 60_000

/** The longest a Gradle run may take: a cold one downloads its distribution and dependencies. */
const GRADLE_TIMEOUT_MS = 30 * 60_000

const ADDRESS = /^TULA_FIXTURE_URL=(http:\/\/127\.0\.0\.1:\d+)$/m

async function fixtureAddress(output: ReadableStream<Uint8Array>): Promise<string> {
  const reader = output.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + FIXTURE_START_MS
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    text += decoder.decode(value, { stream: true })
    const found = ADDRESS.exec(text)
    if (found?.[1]) {
      reader.releaseLock()
      return found[1]
    }
    if (done) {
      break
    }
  }
  throw new Error('the fixture did not say where it listens')
}

const tasks = process.argv.slice(2)
const fixture = Bun.spawn(['bun', 'run', join(ROOT, 'e2e', 'kotlin-fixture.ts')], {
  cwd: ROOT,
  env: { ...process.env, KOTLIN_FIXTURE: '1' },
  stdout: 'pipe',
  stderr: 'inherit',
})

let code = 1
try {
  const address = await Promise.race([
    fixtureAddress(fixture.stdout),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('the fixture did not start in time')), FIXTURE_START_MS)
    ),
  ])
  const gradle = Bun.spawn(
    ['./gradlew', '--console=plain', ...(tasks.length > 0 ? tasks : [':tula-auth:check'])],
    {
      cwd: ANDROID,
      env: { ...process.env, TULA_FIXTURE_URL: address },
      stdout: 'inherit',
      stderr: 'inherit',
      timeout: GRADLE_TIMEOUT_MS,
    }
  )
  code = await gradle.exited
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
} finally {
  fixture.kill()
  await fixture.exited
}
process.exit(code)
