package dev.tula.expo.screens

/**
 * The newest of something that is handed over again and again, read when it is needed.
 *
 * The module's client lives as long as the process; the React Native context that made it does
 * not (a JavaScript reload makes a new one). So what the client's sheets ask for the current
 * activity is not the provider of whoever made the client, but [read], which asks the provider
 * that was handed over last. Plain Kotlin: nothing of Android or Expo is named here.
 */
internal class Latest<T : Any> {
    @Volatile
    private var provider: () -> T? = { null }

    /** Take [next] in place of the provider that was here. */
    fun replace(next: () -> T?) {
        provider = next
    }

    /** Asks the newest provider, each time it is called. Never a provider it was made beside. */
    val read: () -> T? = { provider() }
}
