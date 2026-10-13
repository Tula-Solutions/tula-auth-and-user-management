package dev.tula.auth.journeys

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The Kotlin suite and `conformance/client-journeys.json`, held to each other from the
 * suite's side: what the list says under `kotlin` is what [JourneysTest] has, in both
 * directions, read from the tests themselves by reflection.
 *
 * The rules are those of `packages/conformance/src/client-journeys.ts`
 * (`clientJourneyListProblems`, `clientSuiteProblems`), written again here because this
 * suite is not TypeScript; `.claude/hooks/kotlin-journeys.test.ts` runs the originals over
 * the same file's text in `bun run verify`. A rule added there is added here.
 */
class GuardTest {
    private val root = File(
        System.getProperty("tula.repository.root") ?: throw AssertionError("tula.repository.root is not set"),
    )
    private val text = File(root, "conformance/client-journeys.json").readText()
    private val list = j(text).jsonObject

    private val scenarioNames: List<String> =
        File(root, "conformance/scenarios").listFiles { file -> file.name.endsWith(".json") }.orEmpty()
            .map { j(it.readText()).jsonObject.text("name") }

    private val tests = JourneysTest::class.java.declaredMethods.filter {
        it.isAnnotationPresent(Journey::class.java) || it.isAnnotationPresent(Behaviour::class.java)
    }
    private val journeys: Set<String> =
        tests.flatMap { it.getAnnotation(Journey::class.java)?.scenarios?.toList().orEmpty() }.toSet()
    private val behaviours: Set<String> = tests.mapNotNull { it.getAnnotation(Behaviour::class.java)?.id }.toSet()

    private fun decision(entry: JsonObject?): JsonObject? = entry?.get("kotlin") as? JsonObject

    private fun JsonObject.word(name: String): String? = (this[name] as? JsonPrimitive)?.content

    @Test
    fun `the list writes no key twice`() {
        // A parser keeps one of the two and says nothing: a decision could hide behind another.
        assertEquals(emptyList(), duplicateKeys(text))
        assertEquals(listOf("/a"), duplicateKeys("""{"a":1,"b":{"a":2,"c":[{"a":1}]},"a":"}"}"""))
        assertEquals(listOf("/b/a"), duplicateKeys("""{"a":1,"b":{"a":2,"a":3}}"""))
    }

    @Test
    fun `the list says the Kotlin suite exists`() {
        assertEquals("exists", list.getValue("clients").jsonObject.getValue("kotlin").jsonObject.word("suite"))
    }

    @Test
    fun `every scenario has a decision for kotlin, and the suite has a test for exactly the journeys`() {
        assertTrue(scenarioNames.size >= 16)
        val scenarios = list.getValue("scenarios").jsonObject
        val problems = ArrayList<String>()
        for (name in scenarios.keys - scenarioNames.toSet()) {
            problems += "the list has \"$name\", which is no scenario"
        }
        for (name in scenarioNames) {
            val decided = decision(scenarios[name] as? JsonObject)
            val reason = decided?.word("reason").orEmpty().trim()
            when (decided?.word("decision")) {
                "journey" -> if (name !in journeys) problems += "\"$name\" is a journey with no test"
                "not_applicable" -> {
                    if (reason.length < MIN_REASON_LENGTH) problems += "\"$name\" is not applicable with no reason"
                    if (name in journeys) problems += "\"$name\" is not applicable and has a test"
                }
                "not_built" -> {
                    if (!TICKET.matches(decided.word("ticket").orEmpty())) problems += "\"$name\" is not built with no ticket"
                    if (reason.isEmpty()) problems += "\"$name\" is not built with no reason"
                    if (name in journeys) problems += "\"$name\" is not built and has a test: it is built"
                }
                else -> problems += "\"$name\" has no decision for kotlin, whose suite exists"
            }
        }
        for (name in journeys - scenarioNames.toSet()) {
            problems += "a test is the journey of \"$name\", which is no scenario"
        }
        assertEquals(emptyList(), problems)
    }

    @Test
    fun `every named behaviour is a test of the suite, and the suite names no other`() {
        val listed = list.getValue("behaviours").jsonObject
        assertEquals(
            setOf(
                "concurrent_refresh",
                "refresh_without_answer",
                "unknown_step_not_supported",
                "session_kept_through_failed_refresh_offline",
            ),
            listed.keys,
        )
        for ((id, entry) in listed) {
            // A behaviour is never `not_built`: it is what a client does by itself.
            assertEquals("journey", decision(entry.jsonObject.getValue("clients").jsonObject)?.word("decision"), id)
        }
        assertEquals(listed.keys, behaviours)
    }

    @Test
    fun `a journey or a behaviour is a test that runs`() {
        assertTrue(tests.size >= 16)
        for (test in tests) {
            assertTrue(test.isAnnotationPresent(org.junit.Test::class.java), test.name)
            assertTrue(!test.isAnnotationPresent(org.junit.Ignore::class.java), test.name)
        }
        assertTrue(!JourneysTest::class.java.isAnnotationPresent(org.junit.Ignore::class.java))
    }

    @Test
    fun `what the Kotlin client has not built, ticket by ticket`() {
        // A `not_built` entry is a debt: paying one off, or taking one on, changes this too.
        val counts = list.getValue("scenarios").jsonObject.values
            .mapNotNull { decision(it.jsonObject) }
            .filter { it.word("decision") == "not_built" }
            .groupingBy { it.word("ticket").orEmpty() }
            .eachCount()
        assertEquals(mapOf("TULA-57" to 54, "TULA-61" to 6), counts)
    }

    private companion object {
        /** `MIN_NOT_APPLICABLE_REASON_LENGTH` of the TypeScript checks. */
        const val MIN_REASON_LENGTH = 41
        val TICKET = Regex("^TULA-[0-9]+$")

        /**
         * The keys a JSON text writes twice in one object, as paths.
         *
         * A scan of the text: strings are skipped whole, and each object remembers its keys.
         */
        fun duplicateKeys(text: String): List<String> {
            val found = ArrayList<String>()
            // One frame per open object or array: its path, its keys (null for an array).
            val frames = ArrayDeque<Pair<String, HashSet<String>?>>()
            var pending = ""
            var index = 0
            while (index < text.length) {
                when (text[index]) {
                    '"' -> {
                        val start = index + 1
                        index = start
                        while (text[index] != '"') {
                            index += if (text[index] == '\\') 2 else 1
                        }
                        var after = index + 1
                        while (after < text.length && text[after].isWhitespace()) {
                            after += 1
                        }
                        val keys = frames.lastOrNull()?.second
                        if (keys != null && after < text.length && text[after] == ':') {
                            pending = text.substring(start, index)
                            if (!keys.add(pending)) {
                                found += "${frames.last().first}/$pending"
                            }
                        }
                    }
                    '{' -> frames.addLast(path(frames, pending) to HashSet())
                    '[' -> frames.addLast(path(frames, pending) to null)
                    '}', ']' -> frames.removeLast()
                }
                index += 1
            }
            return found
        }

        private fun path(frames: ArrayDeque<Pair<String, HashSet<String>?>>, key: String): String {
            val parent = frames.lastOrNull() ?: return ""
            return if (parent.second == null) parent.first else "${parent.first}/$key"
        }
    }
}
