package dev.tula.auth.compose

import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import dev.tula.auth.TulaClient
import dev.tula.auth.generated.TulaTheme
import dev.tula.auth.generated.TulaThemeDefaults
import dev.tula.auth.ui.TulaAuthAction
import dev.tula.auth.ui.TulaAuthField
import dev.tula.auth.ui.TulaAuthFieldContent
import dev.tula.auth.ui.TulaAuthFieldKind
import dev.tula.auth.ui.TulaAuthFocus
import dev.tula.auth.ui.TulaAuthMode
import dev.tula.auth.ui.TulaAuthModel
import dev.tula.auth.ui.TulaAuthOffer
import dev.tula.auth.ui.TulaAuthState
import dev.tula.auth.ui.TulaResolvedTheme
import dev.tula.auth.ui.TulaStrings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** The widest a form is drawn: on a tablet it stays a column a line can be read across. */
private val MAX_FORM_WIDTH = 480.dp

/**
 * Sign-in, sign-up, email verification and password reset: one screen per step the server
 * answers, drawn from the app's client.
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
    onSignedIn: (() -> Unit)? = null,
) {
    val told by rememberUpdatedState(onSignedIn)
    val model = remember(client, mode) {
        // What is said to a screen reader is said by the screens' live regions, so the model's
        // own announcements go nowhere here.
        TulaAuthModel(client, mode, strings, onSignedIn = { onMain { told?.invoke() } })
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
    val content = remember(state.screen, state.appName, state.passwordOptional, state.email, model.strings) { model.content }
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
    val body = TextStyle(color = colors.text, fontSize = drawn.fontSize, fontFamily = drawn.fontFamily)
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
            content.identity?.let { Offer(it, drawn, body, state.isPending, perform) }
            model.formProblem?.let {
                BasicText(
                    text = it,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(drawn.radiusSmall))
                        .background(colors.dangerSurface)
                        .padding(drawn.spacing * 0.75f)
                        .semantics { liveRegion = LiveRegionMode.Assertive }
                        .testTag("tula.form.error"),
                    style = body.copy(color = colors.danger),
                )
            }
            state.status?.let {
                BasicText(
                    text = it,
                    modifier = Modifier
                        .semantics { liveRegion = LiveRegionMode.Polite }
                        .testTag("tula.status"),
                    style = body.copy(color = colors.success),
                )
            }
            for (field in content.fields) {
                Field(
                    field = field,
                    model = model,
                    held = held,
                    theme = drawn,
                    focus = fieldFocus.getValue(field.field),
                    onDone = { perform(field.submit) },
                )
            }
            content.primary?.let { primary ->
                slots.primaryButton(
                    TulaAuthButton(
                        title = primary.title,
                        isPending = state.isPending,
                        loading = model.strings.loading,
                        modifier = Modifier.testTag(primary.identifier),
                        theme = drawn,
                        onClick = { perform(primary.action) },
                    ),
                )
            }
            for (link in content.links) {
                Offer(link, drawn, body, state.isPending, perform)
            }
            slots.footer(TulaAuthFooter(model.strings.securedBy, drawn))
        }
    }
}

/** Run on the main thread: now when already there, otherwise as soon as it is free. */
private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
        block()
    } else {
        Handler(Looper.getMainLooper()).post(block)
    }
}

/** A link, with the sentence before it: underlined, so that it is one without its colour. */
@Composable
private fun Offer(
    offer: TulaAuthOffer,
    theme: TulaComposeTheme,
    body: TextStyle,
    isPending: Boolean,
    perform: (TulaAuthAction) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(theme.spacing / 2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        offer.lead?.takeIf { it.isNotEmpty() }?.let {
            BasicText(text = it, modifier = Modifier.weight(1f, fill = false), style = body.copy(color = theme.colors.textMuted))
        }
        Box(
            modifier = Modifier
                .heightIn(min = MIN_TOUCH)
                .clickable(enabled = !isPending, role = Role.Button) { perform(offer.action) }
                .testTag(offer.identifier),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicText(
                text = offer.title,
                style = body.copy(
                    color = theme.colors.link,
                    fontWeight = FontWeight.Medium,
                    textDecoration = TextDecoration.Underline,
                ),
            )
        }
    }
}

/**
 * One field: its label, what is typed, the button that shows a password, the hint and the
 * problems. What is typed is the model's; it is drawn from there and written there, and is in
 * no saved state.
 */
@Composable
private fun Field(
    field: TulaAuthFieldContent,
    model: TulaAuthModel,
    held: MutableState<TulaAuthState>,
    theme: TulaComposeTheme,
    focus: FocusRequester,
    onDone: () -> Unit,
) {
    val state = held.value
    val colors = theme.colors
    val strings = model.strings
    val problems = model.problems(field.field)
    val secret = field.kind == TulaAuthFieldKind.PASSWORD || field.kind == TulaAuthFieldKind.NEW_PASSWORD
    val shown = field.field in state.revealed
    var focused by remember { mutableStateOf(false) }
    val body = TextStyle(color = colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamily)
    val small = TextStyle(color = colors.textMuted, fontSize = theme.fontSizeSmall, fontFamily = theme.fontFamily)
    val spoken = model.spokenLabel(field)
    // Told apart by more than its colour: the edge of a field with a problem, or the focus, is
    // thicker too, and the problem is written under it.
    val edge = when {
        problems.isNotEmpty() -> colors.danger
        focused -> colors.focus
        else -> colors.borderStrong
    }
    val shape = RoundedCornerShape(theme.radius)
    Column(verticalArrangement = Arrangement.spacedBy(theme.spacing / 4)) {
        BasicText(text = field.label, style = body.copy(fontWeight = FontWeight.Medium))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = MIN_TOUCH)
                .clip(shape)
                .background(colors.input)
                .border(if (problems.isNotEmpty() || focused) 2.dp else 1.dp, edge, shape)
                .padding(horizontal = theme.spacing * 0.75f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = state.text(field.field),
                onValueChange = { typed ->
                    model.setText(field.field, typed)
                    // Drawn in the same frame as the key: a state that arrived a frame later
                    // would put the caret where the text is not.
                    held.value = model.state.value
                },
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = theme.spacing / 2)
                    .focusRequester(focus)
                    .onFocusChanged { focused = it.isFocused }
                    .semantics {
                        // The label, and the problems with it when there are any.
                        contentDescription = spoken
                        if (problems.isNotEmpty()) {
                            error(problems.joinToString(" "))
                        }
                        contentTypeOf(field.kind)?.let { contentType = it }
                    }
                    .testTag(field.identifier),
                enabled = !state.isPending,
                textStyle = if (field.kind == TulaAuthFieldKind.CODE) body.copy(fontFamily = theme.fontFamilyMono) else body,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = when (field.kind) {
                        TulaAuthFieldKind.EMAIL -> KeyboardType.Email
                        TulaAuthFieldKind.PASSWORD, TulaAuthFieldKind.NEW_PASSWORD -> KeyboardType.Password
                        TulaAuthFieldKind.CODE -> KeyboardType.Number
                    },
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { onDone() }),
                singleLine = true,
                visualTransformation = if (secret && !shown) PasswordVisualTransformation() else VisualTransformation.None,
                cursorBrush = SolidColor(colors.text),
            )
            if (secret) {
                Box(
                    modifier = Modifier
                        .heightIn(min = MIN_TOUCH)
                        .clickable(role = Role.Button) {
                            model.toggleReveal(field.field)
                            held.value = model.state.value
                        }
                        .padding(start = theme.spacing / 2)
                        .testTag("${field.identifier}.reveal"),
                    contentAlignment = Alignment.Center,
                ) {
                    // In words: "Show password" and "Hide password" say the state.
                    BasicText(
                        text = if (shown) strings.hidePassword else strings.showPassword,
                        style = small.copy(fontWeight = FontWeight.Medium),
                    )
                }
            }
        }
        field.hint?.let { BasicText(text = it, style = small) }
        problems.forEachIndexed { index, problem ->
            BasicText(
                text = problem,
                modifier = Modifier
                    .semantics { liveRegion = LiveRegionMode.Polite }
                    .testTag("${field.identifier}.error.$index"),
                style = small.copy(color = colors.danger),
            )
        }
    }
}

/** What autofill is told a field is. A code is given no type: none of the platform's is an emailed one. */
private fun contentTypeOf(kind: TulaAuthFieldKind): ContentType? = when (kind) {
    TulaAuthFieldKind.EMAIL -> ContentType.EmailAddress + ContentType.Username
    TulaAuthFieldKind.PASSWORD -> ContentType.Password
    TulaAuthFieldKind.NEW_PASSWORD -> ContentType.NewPassword
    TulaAuthFieldKind.CODE -> null
}
