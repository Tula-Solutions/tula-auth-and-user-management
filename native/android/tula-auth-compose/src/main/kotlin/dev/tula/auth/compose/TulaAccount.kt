package dev.tula.auth.compose

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.tula.auth.TulaClient
import dev.tula.auth.generated.TulaTheme
import dev.tula.auth.generated.TulaThemeDefaults
import dev.tula.auth.ui.TulaAccountAction
import dev.tula.auth.ui.TulaAccountField
import dev.tula.auth.ui.TulaAccountFocus
import dev.tula.auth.ui.TulaAccountModel
import dev.tula.auth.ui.TulaAccountOffer
import dev.tula.auth.ui.TulaAccountSection
import dev.tula.auth.ui.TulaResolvedTheme
import dev.tula.auth.ui.TulaStrings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The signed-in user's account: the profile, the password, the phone number, where they are
 * signed in, two-step verification and passkeys, with the forms that change them and
 * "Confirm it is you" where the server asks for a recent authentication.
 *
 * ```kotlin
 * TulaAccount(client, onSignedOut = { /* show the sign-in screens */ })
 * ```
 *
 * The composable makes its own [TulaAccountModel] and keeps it with plain `remember`: nothing
 * typed, no setup key and no backup code is put in `rememberSaveable`, a `SavedStateHandle` or
 * a `Bundle`, and **when it leaves the composition every form is emptied**. A setup key, its QR
 * code and backup codes are there only while their form is open, and are copied only on a
 * press, marked as sensitive ([tulaSensitiveCopy]).
 *
 * **A sign-out the server could not be told of is not a sign-out**: the screen says the session
 * may still be active and offers to sign out again, and [onSignedOut] is not called. The
 * client is signed out locally by then, so an app that swaps this screen for its sign-in screen
 * on the client's state alone would hide that: keep this screen until [onSignedOut].
 *
 * A passkey is added and used through the client's passkey sheet; where the client was given
 * none, that is said in words and no button is drawn. A passkey cannot be renamed here: the
 * client has no call for it, and the screen says so.
 *
 * @param client The app's client, signed in.
 * @param modifier The modifier of the whole screen.
 * @param strings Every string the screen shows.
 * @param theme The theme. A value that is refused is replaced by the default's.
 * @param slots The parts of a screen the app draws itself.
 * @param onSignedOut Called once, on the main thread, for a sign-out the server was told of.
 */
@Composable
fun TulaAccount(
    client: TulaClient,
    modifier: Modifier = Modifier,
    strings: TulaStrings = TulaStrings(),
    theme: TulaTheme = TulaThemeDefaults.theme,
    slots: TulaAuthSlots = TulaAuthSlots(),
    onSignedOut: (() -> Unit)? = null,
) {
    val told by rememberUpdatedState(onSignedOut)
    val context = LocalContext.current
    val model = remember(client) {
        TulaAccountModel(
            client, strings,
            onSignedOut = { onMain { told?.invoke() } },
            copy = tulaSensitiveCopy(context),
        )
    }
    SideEffect { model.strings = strings }
    DisposableEffect(model) { onDispose { model.close() } }
    TulaAccount(model, modifier, theme, slots)
}

/**
 * The same screen over a model the app keeps (in a `ViewModel` without a `SavedStateHandle`).
 * **The owner closes the model** ([TulaAccountModel.close]) when the screen is left for good.
 *
 * @param model The model. Its `onSignedOut` is called on the thread the model finished on, and
 *   its `copy` is the app's to give ([tulaSensitiveCopy]).
 * @param modifier The modifier of the whole screen.
 * @param theme The theme.
 * @param slots The parts of a screen the app draws itself.
 */
@Composable
fun TulaAccount(
    model: TulaAccountModel,
    modifier: Modifier = Modifier,
    theme: TulaTheme = TulaThemeDefaults.theme,
    slots: TulaAuthSlots = TulaAuthSlots(),
) {
    val dark = isSystemInDarkTheme()
    val drawn = remember(theme, dark) { TulaComposeTheme(TulaResolvedTheme.of(theme), dark) }
    // Not the composition's scope: a call that is being sent when the screen leaves is let
    // finish (the client's own deadline ends it), and its answer is dropped by the model.
    val scope = remember(model) { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }
    val held = remember(model) { mutableStateOf(model.state.value) }
    LaunchedEffect(model) { model.state.collect { held.value = it } }
    LaunchedEffect(model) { model.load() }
    val state = held.value
    val content = model.content
    val strings = model.strings
    val perform: (TulaAccountAction) -> Unit = { action -> scope.launch { model.perform(action) } }

    val titleFocus = remember { FocusRequester() }
    val fieldFocus = remember { TulaAccountField.entries.associateWith { FocusRequester() } }
    LaunchedEffect(state.focusRequests) {
        if (state.focusRequests == 0) {
            return@LaunchedEffect
        }
        val target = when (val focus = state.focus) {
            TulaAccountFocus.Title -> titleFocus
            is TulaAccountFocus.Field -> fieldFocus.getValue(focus.field)
        }
        try {
            target.requestFocus()
        } catch (_: IllegalStateException) {
            // The field went with its form between the request and this frame.
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(drawn.colors.background)
            .imePadding()
            .semantics { paneTitle = content.title }
            .testTag("tula.account"),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = MAX_FORM_WIDTH)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(drawn.spacing * 1.5f),
            verticalArrangement = Arrangement.spacedBy(drawn.spacing),
        ) {
            slots.header(
                TulaAuthHeader(
                    title = content.title,
                    subtitle = content.subtitle,
                    titleModifier = Modifier
                        .testTag("tula.title")
                        .semantics { heading() }
                        .focusRequester(titleFocus)
                        .focusable(),
                    theme = drawn,
                ),
            )
            Messages(model.formProblem, state.status, state.notice, drawn)
            content.setup?.let { Setup(it, drawn) }
            content.codes?.let { Codes(it, drawn) }
            content.copy?.let { Offer(it, drawn, enabled = true, perform) }
            for (field in content.fields) {
                Field(
                    FieldPart(
                        identifier = field.identifier,
                        label = field.label,
                        hint = field.hint,
                        kind = field.kind,
                        text = state.text[field.field].orEmpty(),
                        problems = model.problems(field.field),
                        revealed = field.field in state.revealed,
                        enabled = !state.isPending,
                        showPassword = strings.showPassword,
                        hidePassword = strings.hidePassword,
                        onText = { typed ->
                            model.setText(field.field, typed)
                            held.value = model.state.value
                        },
                        onReveal = {
                            model.toggleReveal(field.field)
                            held.value = model.state.value
                        },
                        onDone = { perform(field.submit) },
                    ),
                    drawn,
                    fieldFocus.getValue(field.field),
                )
            }
            for (section in content.sections) {
                Section(section, drawn, strings.loading, !state.isPending, perform)
            }
            content.primary?.let { primary ->
                slots.primaryButton(
                    TulaAuthButton(
                        title = primary.title,
                        isPending = state.isPending,
                        loading = strings.loading,
                        modifier = Modifier.testTag(primary.identifier),
                        theme = drawn,
                        onClick = { perform(primary.action) },
                    ),
                )
            }
            for (link in content.links) {
                Offer(link, drawn, !state.isPending, perform)
            }
            slots.footer(TulaAuthFooter(strings.securedBy, drawn))
        }
    }
}

@Composable
private fun Offer(offer: TulaAccountOffer, theme: TulaComposeTheme, enabled: Boolean, perform: (TulaAccountAction) -> Unit) {
    Link(offer.identifier, offer.title, theme, enabled, label = offer.label, destructive = offer.destructive) {
        perform(offer.action)
    }
}

/** A part of the overview: its heading, what it says, its list and what it offers. */
@Composable
private fun Section(
    section: TulaAccountSection,
    theme: TulaComposeTheme,
    loading: String,
    enabled: Boolean,
    perform: (TulaAccountAction) -> Unit,
) {
    val colors = theme.colors
    val shape = RoundedCornerShape(theme.radius)
    val body = TextStyle(color = colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamily)
    val small = TextStyle(color = colors.textMuted, fontSize = theme.fontSizeSmall, fontFamily = theme.fontFamily)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.surface)
            .border(1.dp, colors.border, shape)
            .padding(theme.spacing)
            .testTag(section.identifier),
        verticalArrangement = Arrangement.spacedBy(theme.spacing / 2),
    ) {
        BasicText(
            text = section.title,
            modifier = Modifier.semantics { heading() },
            style = body.copy(fontWeight = FontWeight.SemiBold),
        )
        if (section.loading) {
            BasicText(text = loading, style = body.copy(color = colors.textMuted))
        }
        for (line in section.lines) {
            BasicText(text = line, style = body.copy(color = colors.textMuted))
        }
        for (row in section.rows) {
            Column(
                modifier = Modifier.fillMaxWidth().testTag(row.identifier),
                verticalArrangement = Arrangement.spacedBy(theme.spacing / 8),
            ) {
                BasicText(text = row.title, style = body.copy(fontWeight = FontWeight.Medium))
                // What a row is marked as is written out: "This device", "Bound to a device key".
                for (mark in row.marks) {
                    BasicText(text = mark, style = small.copy(color = colors.text, fontWeight = FontWeight.Medium))
                }
                for (detail in row.details) {
                    BasicText(text = detail, style = small)
                }
                row.offer?.let { Offer(it, theme, enabled, perform) }
            }
        }
        for (offer in section.offers) {
            Offer(offer, theme, enabled, perform)
        }
    }
}
