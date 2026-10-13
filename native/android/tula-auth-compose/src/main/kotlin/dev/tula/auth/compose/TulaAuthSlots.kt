package dev.tula.auth.compose

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** The smallest a control is in either direction: what a finger, and TalkBack, can hit. */
internal val MIN_TOUCH = 48.dp

/** How wide the edge of a control with the focus is. */
internal val FOCUS_EDGE = 2.dp

/**
 * The edge of a control that has the focus, for someone who moves through the screen with a
 * keyboard or a switch, in the theme's focus colour.
 *
 * The edge is always part of the control and is transparent without the focus: a modifier put
 * in only then would rebuild what follows it, and the control would lose the focus it just got.
 *
 * @param focused Whether the control has the focus.
 * @param theme The theme.
 * @param shape The control's shape.
 * @param inner What the control is filled with when that is not the page: a second edge of the
 *   page's colour is then drawn inside the first, because the focus colour is chosen to be told
 *   from the page (3:1 on `background`) and promises nothing against a button's own colour.
 */
internal fun Modifier.focusEdge(
    focused: Boolean,
    theme: TulaComposeTheme,
    shape: Shape,
    inner: Boolean = false,
): Modifier {
    val edge = if (focused) theme.colors.focus else Color.Transparent
    val outer = border(FOCUS_EDGE, edge, shape)
    return if (inner) {
        // Drawn first, so under the edge above: what shows of it is the band inside that edge.
        outer.border(FOCUS_EDGE * 2, if (focused) theme.colors.background else Color.Transparent, shape)
    } else {
        outer
    }
}

/** What a header slot draws: a screen's title and what is under it. */
@Immutable
class TulaAuthHeader internal constructor(
    /** The screen's title. */
    val title: String,
    /** What is under the title, when the screen has it. */
    val subtitle: String?,
    /**
     * To be put on what is read as the title: it makes it a heading, lets it take the focus when
     * the step changes, and is what a UI test finds it by. A slot that leaves it out draws a
     * title a screen reader is not moved to.
     */
    val titleModifier: Modifier,
    /** The theme, for a slot that wants its colours and sizes. */
    val theme: TulaComposeTheme,
)

/** What a main-button slot draws. */
@Immutable
class TulaAuthButton internal constructor(
    /** The words on the button. */
    val title: String,
    /** Whether an action is being sent: the button then does nothing. */
    val isPending: Boolean,
    /** What is said of the button while an action is being sent ("Loading…"). */
    val loading: String,
    /**
     * To be put on the button: what a UI test finds it by. It draws nothing, so a slot that
     * replaces the button shows by itself that the button has the focus, as the default does
     * with the theme's focus colour.
     */
    val modifier: Modifier,
    /** The theme. */
    val theme: TulaComposeTheme,
    /** What the button does. The screens do nothing with a second press while one is sent. */
    val onClick: () -> Unit,
)

/** What a footer slot draws. */
@Immutable
class TulaAuthFooter internal constructor(
    /** The last line of every screen ("Secured by Tula"). */
    val text: String,
    /** The theme. */
    val theme: TulaComposeTheme,
)

/**
 * The parts of a screen an app may draw itself. Each has a default, so an app replaces only
 * what it wants:
 *
 * ```kotlin
 * TulaAuth(
 *     client = client,
 *     slots = TulaAuthSlots(
 *         header = { header ->
 *             Image(painterResource(R.drawable.logo), contentDescription = null)
 *             TulaAuthDefaults.Header(header)
 *         },
 *         footer = {},
 *     ),
 * )
 * ```
 *
 * The fields, the links and the problems are not slots: what is typed, how a problem is
 * associated with its field and how it is said belong to the screens.
 *
 * A slot is handed words, a theme and a callback, and nothing that is typed: no password and
 * no code reaches one.
 *
 * @param header The title and what is under it.
 * @param primaryButton The screen's main button.
 * @param footer The last line.
 */
@Immutable
class TulaAuthSlots(
    val header: @Composable (TulaAuthHeader) -> Unit = { TulaAuthDefaults.Header(it) },
    val primaryButton: @Composable (TulaAuthButton) -> Unit = { TulaAuthDefaults.PrimaryButton(it) },
    val footer: @Composable (TulaAuthFooter) -> Unit = { TulaAuthDefaults.Footer(it) },
)

/** The default of every slot, for an app that wraps one instead of replacing it. */
object TulaAuthDefaults {
    /**
     * The default header: the title, as a heading, and the subtitle under it.
     *
     * @param header What to draw.
     */
    @Composable
    fun Header(header: TulaAuthHeader) {
        val theme = header.theme
        Column(verticalArrangement = Arrangement.spacedBy(theme.spacing / 4)) {
            BasicText(
                text = header.title,
                modifier = header.titleModifier,
                style = TextStyle(
                    color = theme.colors.text,
                    fontSize = theme.fontSizeTitle,
                    fontFamily = theme.fontFamily,
                    fontWeight = FontWeight.SemiBold,
                ),
            )
            header.subtitle?.let {
                BasicText(
                    text = it,
                    style = TextStyle(color = theme.colors.textMuted, fontSize = theme.fontSize, fontFamily = theme.fontFamily),
                )
            }
        }
    }

    /**
     * The default main button. While an action is being sent it says so in words, and is
     * disabled for a screen reader too: its state is never only a colour. With the focus it
     * has an edge of the theme's focus colour, and one of the page's colour inside it.
     *
     * @param button What to draw.
     */
    @Composable
    fun PrimaryButton(button: TulaAuthButton) {
        val theme = button.theme
        val interaction = remember { MutableInteractionSource() }
        val pressed by interaction.collectIsPressedAsState()
        val focused by interaction.collectIsFocusedAsState()
        val shape = RoundedCornerShape(theme.radius)
        Box(
            modifier = button.modifier
                .fillMaxWidth()
                .heightIn(min = MIN_TOUCH)
                .clip(shape)
                .background(if (pressed) theme.colors.primaryHover else theme.colors.primary)
                .focusEdge(focused, theme, shape, inner = true)
                .clickable(
                    interactionSource = interaction,
                    indication = null,
                    enabled = !button.isPending,
                    role = Role.Button,
                    onClick = button.onClick,
                )
                .semantics {
                    if (button.isPending) {
                        disabled()
                        stateDescription = button.loading
                    }
                }
                .padding(horizontal = theme.spacing, vertical = theme.spacing / 2),
            contentAlignment = Alignment.Center,
        ) {
            BasicText(
                text = if (button.isPending) button.loading else button.title,
                style = TextStyle(
                    color = theme.colors.primaryText,
                    fontSize = theme.fontSize,
                    fontFamily = theme.fontFamily,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                ),
            )
        }
    }

    /**
     * The default footer: one quiet line.
     *
     * @param footer What to draw.
     */
    @Composable
    fun Footer(footer: TulaAuthFooter) {
        val theme = footer.theme
        BasicText(
            text = footer.text,
            modifier = Modifier.fillMaxWidth(),
            style = TextStyle(
                color = theme.colors.textMuted,
                fontSize = theme.fontSizeSmall,
                fontFamily = theme.fontFamily,
                textAlign = TextAlign.Center,
            ),
        )
    }
}
