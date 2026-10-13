package dev.tula.expo.screens

import android.content.Context
import android.view.ViewGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import dev.tula.auth.compose.TulaAccount
import dev.tula.auth.compose.TulaAuth
import dev.tula.auth.generated.TulaTheme
import dev.tula.auth.generated.TulaThemeDefaults
import dev.tula.auth.generated.TulaThemeScheme
import dev.tula.auth.ui.TulaAuthMode
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * The theme a screen is drawn with: the default, with the values JavaScript sent in place of
 * the default's. JavaScript sends only values it checked with the contract's grammar, and the
 * screens check every value again before they draw one (`TulaResolvedTheme`): what this
 * function builds is still untrusted strings. A key that is not a token, and a value that is
 * no string, are left out.
 */
internal fun themeOf(overrides: Map<String, Any?>?): TulaTheme {
    val base = TulaThemeDefaults.theme
    if (overrides == null) {
        return base
    }
    fun text(source: Map<*, *>, key: String, fallback: String): String = source[key] as? String ?: fallback
    fun scheme(from: TulaThemeScheme, source: Any?): TulaThemeScheme {
        val given = source as? Map<*, *> ?: return from
        return TulaThemeScheme(
            background = text(given, "background", from.background),
            surface = text(given, "surface", from.surface),
            input = text(given, "input", from.input),
            text = text(given, "text", from.text),
            textMuted = text(given, "textMuted", from.textMuted),
            primary = text(given, "primary", from.primary),
            primaryHover = text(given, "primaryHover", from.primaryHover),
            primaryText = text(given, "primaryText", from.primaryText),
            link = text(given, "link", from.link),
            border = text(given, "border", from.border),
            borderStrong = text(given, "borderStrong", from.borderStrong),
            danger = text(given, "danger", from.danger),
            dangerSurface = text(given, "dangerSurface", from.dangerSurface),
            success = text(given, "success", from.success),
            focus = text(given, "focus", from.focus),
            overlay = text(given, "overlay", from.overlay),
            shadow = text(given, "shadow", from.shadow),
        )
    }
    return TulaTheme(
        light = scheme(base.light, overrides["light"]),
        dark = scheme(base.dark, overrides["dark"]),
        radius = text(overrides, "radius", base.radius),
        radiusSmall = text(overrides, "radiusSmall", base.radiusSmall),
        fontFamily = text(overrides, "fontFamily", base.fontFamily),
        fontFamilyMono = text(overrides, "fontFamilyMono", base.fontFamilyMono),
        fontSize = text(overrides, "fontSize", base.fontSize),
        fontSizeSmall = text(overrides, "fontSizeSmall", base.fontSizeSmall),
        fontSizeTitle = text(overrides, "fontSizeTitle", base.fontSizeTitle),
        spacing = text(overrides, "spacing", base.spacing),
    )
}

/** A React Native view that holds one Compose screen, laid out by Android inside its frame. */
abstract class TulaScreenView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    // Compose asks for a layout when its content changes, and React Native lays out only
    // what it manages itself.
    override val shouldUseAndroidLayout: Boolean = true

    /** The theme, as untrusted strings: see [themeOf]. */
    internal val theme = mutableStateOf(TulaThemeDefaults.theme)

    /** Put the screen in the view. Called once, by the subclass, when its state exists. */
    protected fun draw(content: @Composable () -> Unit) {
        val compose = ComposeView(context)
        // The screen's model is closed when the composition goes, which is when the view
        // leaves its window: an open flow is discarded and its fields are emptied.
        compose.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
        compose.setContent(content)
        addView(
            compose,
            LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
    }
}

/**
 * Sign-in, sign-up and password reset: `tula-auth-compose`'s `TulaAuth` on the module's
 * client. It draws nothing until the module was configured.
 */
class TulaAuthScreenView(context: Context, appContext: AppContext) : TulaScreenView(context, appContext) {
    /** Sent once per completed sign-in or sign-up. It carries nothing. */
    internal val onSignedIn by EventDispatcher()

    internal val mode = mutableStateOf(TulaAuthMode.SIGN_IN)

    /** Where a provider's page comes back to. The server judges it, never this view. */
    internal val redirectUrl = mutableStateOf<String?>(null)

    init {
        draw {
            val client = TulaScreensHost.client
            if (client != null) {
                TulaAuth(
                    client = client,
                    mode = mode.value,
                    theme = theme.value,
                    redirectUrl = redirectUrl.value,
                    onSignedIn = { onSignedIn(emptyMap()) },
                )
            }
        }
    }
}

/**
 * The signed-in user's account: `tula-auth-compose`'s `TulaAccount` on the module's client.
 */
class TulaAccountScreenView(context: Context, appContext: AppContext) : TulaScreenView(context, appContext) {
    /** Sent for a sign-out the server was told of, never for one that failed. */
    internal val onSignedOut by EventDispatcher()

    init {
        draw {
            val client = TulaScreensHost.client
            if (client != null) {
                TulaAccount(
                    client = client,
                    theme = theme.value,
                    onSignedOut = { onSignedOut(emptyMap()) },
                )
            }
        }
    }
}
