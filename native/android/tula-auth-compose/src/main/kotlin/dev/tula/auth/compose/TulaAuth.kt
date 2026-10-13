package dev.tula.auth.compose

import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.background
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.tula.auth.TulaClient
import dev.tula.auth.generated.TulaTheme
import dev.tula.auth.generated.TulaThemeDefaults
import dev.tula.auth.ui.TulaAuthAction
import dev.tula.auth.ui.TulaAuthField
import dev.tula.auth.ui.TulaAuthFocus
import dev.tula.auth.ui.TulaAuthMode
import dev.tula.auth.ui.TulaAuthModel
import dev.tula.auth.ui.TulaResolvedTheme
import dev.tula.auth.ui.TulaStrings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** The widest a form is drawn: on a tablet it stays a column a line can be read across. */
internal val MAX_FORM_WIDTH = 480.dp

/**
 * Sign-in, sign-up, email verification, the second step, the enrolment of an authenticator
 * inside a sign-in and password reset: one screen per step the server answers, drawn from the
 * app's client. A passkey, Google's account chooser and a provider's page are offered where the
 * environment has them on **and the client was given the sheet for them**
 * ([dev.tula.auth.TulaClient.sheets]): a way this client cannot take is never drawn.
 *
 * ```kotlin
 * val state by client.state.collectAsState()
 * if (state is AuthState.SignedIn) Home() else TulaAuth(client, onSignedIn = { /* navigate */ })
 * ```
 *
 * The composable makes its own [TulaAuthModel] and keeps it with plain `remember`: nothing that
 * is typed is put in `rememberSaveable`, a `SavedStateHandle` or a `Bundle`. **When it leaves
 * the composition the open flow is discarded and every field is emptied**, so an activity that
 * is recreated (a rotation the manifest does not handle) starts the screen again. An app that
 * wants an attempt to live through that hoists the model with [TulaAuth]'s other form.
 *
 * Where the app goes after a sign-in is [onSignedIn] and nothing else: the screens read no
 * address from an intent or from the server.
 *
 * `FLAG_SECURE` (no screenshot, nothing in the recents list) is a window's, and so the app's to
 * set on its activity; the screens do not set it.
 *
 * @param client The app's client.
 * @param modifier The modifier of the whole screen.
 * @param mode The flow to open on.
 * @param strings Every string the screens show.
 * @param theme The theme: the generated defaults with what the app, or a tenant, changed. A
 *   value that is refused is replaced by the default's and never drawn.
 * @param slots The parts of a screen the app draws itself.
 * @param redirectUrl Where a provider's page returns to: a redirect URL the environment lists
 *   and the app's manifest claims. Without one no provider that needs a browser is offered.
 * @param onSignedIn Called once for each flow that completed, on the main thread: also when
 *   the session could not be stored, and also after the screen has left the composition if the
 *   flow had already completed by then.
 */
@Composable
fun TulaAuth(
    client: TulaClient,
    modifier: Modifier = Modifier,
    mode: TulaAuthMode = TulaAuthMode.SIGN_IN,
    strings: TulaStrings = TulaStrings(),
    theme: TulaTheme = TulaThemeDefaults.theme,
    slots: TulaAuthSlots = TulaAuthSlots(),
    redirectUrl: String? = null,
    onSignedIn: (() -> Unit)? = null,
) {
    val told by rememberUpdatedState(onSignedIn)
    val context = LocalContext.current
    val model = remember(client, mode, redirectUrl) {
        // What is said to a screen reader is said by the screens' live regions, so the model's
        // own announcements go nowhere here.
        TulaAuthModel(
            client, mode, strings,
            onSignedIn = { onMain { told?.invoke() } },
            redirectUrl = redirectUrl,
            copy = tulaSensitiveCopy(context),
        )
    }
    SideEffect { model.strings = strings }
    // The model was made here, so it is closed here: the flow is discarded, the fields emptied.
    DisposableEffect(model) { onDispose { model.close() } }
    TulaAuth(model, modifier, theme, slots)
}

/**
 * The same screens over a model the app keeps: in a `ViewModel` (without a `SavedStateHandle`),
 * for an attempt that lives through a recreated activity.
 *
 * **The owner closes the model** ([TulaAuthModel.close]) when the screens are left for good:
 * this form does not, because it cannot tell a rotation from a way out. Until then the model
 * holds what was typed.
 *
 * @param model The model. Its `onSignedIn` is called on the thread the model finished on.
 * @param modifier The modifier of the whole screen.
 * @param theme The theme.
 * @param slots The parts of a screen the app draws itself.
 */
@Composable
fun TulaAuth(
    model: TulaAuthModel,
    modifier: Modifier = Modifier,
    theme: TulaTheme = TulaThemeDefaults.theme,
    slots: TulaAuthSlots = TulaAuthSlots(),
) {
    val dark = isSystemInDarkTheme()
    val drawn = remember(theme, dark) { TulaComposeTheme(TulaResolvedTheme.of(theme), dark) }
    // Not the composition's scope: an action that is being sent when the screen leaves is let
    // finish, so that a flow that completed is still told to the app. The client's own
    // deadline ends every call.
    val scope = remember(model) { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }
    val held = remember(model) { mutableStateOf(model.state.value) }
    LaunchedEffect(model) { model.state.collect { held.value = it } }
    LaunchedEffect(model) { model.loadConfig() }
    val state = held.value
    // Made again whenever the state is: it is data, and what it holds of a setup key or of
    // backup codes is not kept anywhere by being remembered.
    val content = model.content
    val perform: (TulaAuthAction) -> Unit = { action -> scope.launch { model.perform(action) } }

    val titleFocus = remember { FocusRequester() }
    val fieldFocus = remember { TulaAuthField.entries.associateWith { FocusRequester() } }
    LaunchedEffect(state.focusRequests) {
        // The screen a composable opens on takes no focus by itself: the app decides that.
        if (state.focusRequests == 0) {
            return@LaunchedEffect
        }
        val target = when (val focus = state.focus) {
            TulaAuthFocus.Title -> titleFocus
            is TulaAuthFocus.Field -> fieldFocus.getValue(focus.field)
        }
        try {
            target.requestFocus()
        } catch (_: IllegalStateException) {
            // The field went with its screen between the request and this frame: there is
            // nothing to move the focus to, and the next request names what is drawn.
        }
    }

    val colors = drawn.colors
    val strings = model.strings
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.background)
            .imePadding()
            // A screen reader says the new screen's name when the step changes.
            .semantics { paneTitle = content.title }
            .testTag("tula.screen"),
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
            content.identity?.let { offer ->
                Link(offer.identifier, offer.title, drawn, !state.isPending, lead = offer.lead) { perform(offer.action) }
            }
            Messages(model.formProblem, state.status, state.notice, drawn)
            content.note?.let { Sentence(it, drawn, modifier = Modifier.testTag("tula.note")) }
            content.setup?.let { Setup(it, drawn) }
            content.codes?.let { Codes(it, drawn) }
            content.copy?.let { offer ->
                // Enabled also while a call is on its way: copying sends nothing.
                Link(offer.identifier, offer.title, drawn, enabled = true) { perform(offer.action) }
            }
            for (field in content.fields) {
                Field(
                    FieldPart(
                        identifier = field.identifier,
                        label = field.label,
                        hint = field.hint,
                        kind = field.kind,
                        text = state.text(field.field),
                        problems = model.problems(field.field),
                        revealed = field.field in state.revealed,
                        enabled = !state.isPending,
                        showPassword = strings.showPassword,
                        hidePassword = strings.hidePassword,
                        onText = { typed ->
                            model.setText(field.field, typed)
                            // Drawn in the same frame as the key: a state that arrived a frame
                            // later would put the caret where the text is not.
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
            content.divider?.let {
                Sentence(it, drawn, modifier = Modifier.fillMaxWidth().testTag("tula.divider"), align = TextAlign.Center)
            }
            for (way in content.ways) {
                OutlinedButton(way.identifier, way.title, drawn, !state.isPending) { perform(way.action) }
            }
            for (link in content.links) {
                Link(link.identifier, link.title, drawn, !state.isPending, lead = link.lead) { perform(link.action) }
            }
            slots.footer(TulaAuthFooter(strings.securedBy, drawn))
        }
    }
}

/** Run on the main thread: now when already there, otherwise as soon as it is free. */
internal fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
        block()
    } else {
        Handler(Looper.getMainLooper()).post(block)
    }
}
