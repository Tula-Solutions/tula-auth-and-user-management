# Consumer rules of the Tula Kotlin client, read by R8 from the jar (TULA-130).
#
# JdkHttpEngine, which sends PATCH on a JVM, refers to java.net.http, which Android does not
# have. It is reached only by name at run time, so R8 normally removes it; an app whose own
# rules keep the whole package (-keep class dev.tula.auth.** { *; }) would otherwise fail on
# "Missing class java.net.http.*". The client falls back to HttpURLConnection, which Android's
# OkHttp-backed implementation allows PATCH on, when the class cannot be made.
-dontwarn java.net.http.**
