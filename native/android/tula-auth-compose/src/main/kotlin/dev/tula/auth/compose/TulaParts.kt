package dev.tula.auth.compose

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import dev.tula.auth.ui.TulaAuthCodesContent
import dev.tula.auth.ui.TulaAuthFieldKind
import dev.tula.auth.ui.TulaAuthSetupContent
import dev.tula.auth.ui.TulaQr
import dev.tula.auth.ui.TulaQrMatrix

// The parts the sign-in screens and the account screen are both drawn from. Nothing here
// decides anything: each draws what it is handed and calls back.

/** `ClipDescription.EXTRA_IS_SENSITIVE`, which the platform names from API 33 and reads from then. */
private const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"

/** How wide a QR code is drawn, its quiet zone included. */
private val QR_SIZE = 220.dp

/** The modules of empty edge around a QR code that a scanner needs. */
private const val QUIET_ZONE = 4

/**
 * What puts a setup key or backup codes on the clipboard for the screens: as text marked
 * sensitive, so that Android 13 and later do not show it in the clipboard's preview.
 *
 * It is called only when a person presses "Copy". **Android gives an app no way to make a clip
 * expire or to take it back**: what was copied stays until something else is copied (some
 * versions clear a clip by themselves after a time), and before Android 13 the mark is not read.
 * The screens say "Copied." and nothing more.
 *
 * @param context A context.
 * @return The function a [dev.tula.auth.ui.TulaAuthModel] or a
 *   [dev.tula.auth.ui.TulaAccountModel] the app keeps is given as `copy`.
 */
fun tulaSensitiveCopy(context: Context): (String) -> Unit {
    val application = context.applicationContext
    return { text ->
        val clip = ClipData.newPlainText("", text)
        clip.description.extras = PersistableBundle().apply { putBoolean(EXTRA_IS_SENSITIVE, true) }
        application.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
    }
}

/** A field, as either screen hands it over. */
internal class FieldPart(
    val identifier: String,
    val label: String,
    val hint: String?,
    val kind: TulaAuthFieldKind,
    val text: String,
    val problems: List<String>,
    val revealed: Boolean,
    val enabled: Boolean,
    val showPassword: String,
    val hidePassword: String,
    val onText: (String) -> Unit,
    val onReveal: () -> Unit,
    val onDone: () -> Unit,
)

/**
 * One field: its label, what is typed, the button that shows a password, the hint and the
 * problems. What is typed is the model's; it is drawn from there and written there, and is in
 * no saved state.
 */
@Composable
internal fun Field(part: FieldPart, theme: TulaComposeTheme, focus: FocusRequester) {
    val colors = theme.colors
    val problems = part.problems
    val secret = part.kind == TulaAuthFieldKind.PASSWORD || part.kind == TulaAuthFieldKind.NEW_PASSWORD
    var focused by remember { mutableStateOf(false) }
    val body = TextStyle(color = colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamily)
    val small = TextStyle(color = colors.textMuted, fontSize = theme.fontSizeSmall, fontFamily = theme.fontFamily)
    // Told apart by more than its colour: the edge of a field with a problem, or the focus, is
    // thicker too, and the problem is written under it.
    val edge = when {
        problems.isNotEmpty() -> colors.danger
        focused -> colors.focus
        else -> colors.borderStrong
    }
    val shape = RoundedCornerShape(theme.radius)
    val typedInMono = part.kind == TulaAuthFieldKind.CODE || part.kind == TulaAuthFieldKind.SMS_CODE ||
        part.kind == TulaAuthFieldKind.BACKUP_CODE
    Column(verticalArrangement = Arrangement.spacedBy(theme.spacing / 4)) {
        BasicText(text = part.label, style = body.copy(fontWeight = FontWeight.Medium))
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
                value = part.text,
                onValueChange = part.onText,
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = theme.spacing / 2)
                    .focusRequester(focus)
                    .onFocusChanged { focused = it.isFocused }
                    .semantics {
                        // The label and nothing else: a problem is said once by `error`
                        // and announced once by the line under the field. In the label too it
                        // would be a third time.
                        contentDescription = part.label
                        if (problems.isNotEmpty()) {
                            error(problems.joinToString(" "))
                        }
                        contentTypeOf(part.kind)?.let { contentType = it }
                    }
                    .testTag(part.identifier),
                enabled = part.enabled,
                textStyle = if (typedInMono) body.copy(fontFamily = theme.fontFamilyMono) else body,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = when (part.kind) {
                        // An address or a phone number: the email keyboard has the digits and "+".
                        TulaAuthFieldKind.EMAIL, TulaAuthFieldKind.IDENTIFIER -> KeyboardType.Email
                        TulaAuthFieldKind.PASSWORD, TulaAuthFieldKind.NEW_PASSWORD -> KeyboardType.Password
                        TulaAuthFieldKind.CODE, TulaAuthFieldKind.SMS_CODE -> KeyboardType.Number
                        TulaAuthFieldKind.BACKUP_CODE -> KeyboardType.Ascii
                        TulaAuthFieldKind.PHONE -> KeyboardType.Phone
                    },
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { part.onDone() }),
                singleLine = true,
                visualTransformation = if (secret && !part.revealed) PasswordVisualTransformation() else VisualTransformation.None,
                cursorBrush = SolidColor(colors.text),
            )
            if (secret) {
                val interaction = remember { MutableInteractionSource() }
                val revealFocused by interaction.collectIsFocusedAsState()
                Box(
                    modifier = Modifier
                        .widthIn(min = MIN_TOUCH)
                        .heightIn(min = MIN_TOUCH)
                        .focusEdge(revealFocused, theme, shape)
                        .clickable(
                            interactionSource = interaction,
                            indication = LocalIndication.current,
                            role = Role.Button,
                            onClick = part.onReveal,
                        )
                        .padding(start = theme.spacing / 2)
                        .testTag("${part.identifier}.reveal"),
                    contentAlignment = Alignment.Center,
                ) {
                    // In words: "Show password" and "Hide password" say the state.
                    BasicText(
                        text = if (part.revealed) part.hidePassword else part.showPassword,
                        style = small.copy(fontWeight = FontWeight.Medium),
                    )
                }
            }
        }
        part.hint?.let { BasicText(text = it, style = small) }
        problems.forEachIndexed { index, problem ->
            BasicText(
                text = problem,
                modifier = Modifier
                    .semantics { liveRegion = LiveRegionMode.Polite }
                    .testTag("${part.identifier}.error.$index"),
                style = small.copy(color = colors.danger),
            )
        }
    }
}

/**
 * What autofill is told a field is. A texted code is the platform's `SmsOtpCode`: the keyboard
 * and an autofill service can then offer the code from the message, and the screens ask for no
 * SMS permission and read no message themselves. An emailed code, an authenticator's and a
 * backup code are given no type: none of the platform's is one of them.
 */
private fun contentTypeOf(kind: TulaAuthFieldKind): ContentType? = when (kind) {
    TulaAuthFieldKind.EMAIL -> ContentType.EmailAddress + ContentType.Username
    TulaAuthFieldKind.IDENTIFIER -> ContentType.Username
    TulaAuthFieldKind.PASSWORD -> ContentType.Password
    TulaAuthFieldKind.NEW_PASSWORD -> ContentType.NewPassword
    TulaAuthFieldKind.SMS_CODE -> ContentType.SmsOtpCode
    TulaAuthFieldKind.PHONE -> ContentType.PhoneNumber
    TulaAuthFieldKind.CODE, TulaAuthFieldKind.BACKUP_CODE -> null
}

/**
 * A link, with the sentence before it: underlined, so that it is one without its colour. One
 * that removes or turns something off says so in its title; its colour only repeats that.
 */
@Composable
internal fun Link(
    identifier: String,
    title: String,
    theme: TulaComposeTheme,
    enabled: Boolean,
    lead: String? = null,
    label: String? = null,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    val body = TextStyle(color = theme.colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamily)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(theme.spacing / 2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        lead?.takeIf { it.isNotEmpty() }?.let {
            BasicText(text = it, modifier = Modifier.weight(1f, fill = false), style = body.copy(color = theme.colors.textMuted))
        }
        val interaction = remember { MutableInteractionSource() }
        val focused by interaction.collectIsFocusedAsState()
        Box(
            modifier = Modifier
                .widthIn(min = MIN_TOUCH)
                .heightIn(min = MIN_TOUCH)
                .focusEdge(focused, theme, RoundedCornerShape(theme.radius))
                .clickable(
                    interactionSource = interaction,
                    indication = LocalIndication.current,
                    enabled = enabled,
                    role = Role.Button,
                    onClick = onClick,
                )
                .semantics { label?.let { contentDescription = it } }
                .testTag(identifier),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicText(
                text = title,
                style = body.copy(
                    color = if (destructive) theme.colors.danger else theme.colors.link,
                    fontWeight = FontWeight.Medium,
                    textDecoration = TextDecoration.Underline,
                ),
            )
        }
    }
}

/** A second button of a screen: another way to sign in. Outlined, as wide as the form. */
@Composable
internal fun OutlinedButton(identifier: String, title: String, theme: TulaComposeTheme, enabled: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(theme.radius)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH)
            .clip(shape)
            .background(theme.colors.surface)
            .border(1.dp, theme.colors.borderStrong, shape)
            .focusEdge(focused, theme, shape)
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = theme.spacing, vertical = theme.spacing / 2)
            .testTag(identifier),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(
            text = title,
            style = TextStyle(
                color = theme.colors.text,
                fontSize = theme.fontSize,
                fontFamily = theme.fontFamily,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            ),
        )
    }
}

/** A sentence of a screen. */
@Composable
internal fun Sentence(
    text: String,
    theme: TulaComposeTheme,
    modifier: Modifier = Modifier,
    muted: Boolean = true,
    align: TextAlign = TextAlign.Start,
) {
    BasicText(
        text = text,
        modifier = modifier,
        style = TextStyle(
            color = if (muted) theme.colors.textMuted else theme.colors.text,
            fontSize = theme.fontSize,
            fontFamily = theme.fontFamily,
            textAlign = align,
        ),
    )
}

/**
 * What went wrong above the form, what went right, and what is neither (a sheet that was
 * closed): each a line of its own, each said to a screen reader, the first at once.
 */
@Composable
internal fun Messages(problem: String?, status: String?, notice: String?, theme: TulaComposeTheme) {
    val colors = theme.colors
    val body = TextStyle(color = colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamily)
    problem?.let {
        BasicText(
            text = it,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(theme.radiusSmall))
                .background(colors.dangerSurface)
                .padding(theme.spacing * 0.75f)
                .semantics { liveRegion = LiveRegionMode.Assertive }
                .testTag("tula.form.error"),
            style = body.copy(color = colors.danger),
        )
    }
    status?.let {
        BasicText(
            text = it,
            modifier = Modifier
                .semantics { liveRegion = LiveRegionMode.Polite }
                .testTag("tula.status"),
            style = body.copy(color = colors.success),
        )
    }
    // Neither a problem nor a success: the text colour, said politely.
    notice?.let {
        BasicText(
            text = it,
            modifier = Modifier
                .semantics { liveRegion = LiveRegionMode.Polite }
                .testTag("tula.notice"),
            style = body.copy(color = colors.textMuted),
        )
    }
}

/**
 * An authenticator's QR code and setup key. The code is made here from the URI and kept in the
 * composition only: it leaves with the screen. Dark on white with a quiet zone, whatever the
 * theme, because that is what a scanner reads. A URI too long for a code draws none, and the
 * key under it is what is used then.
 */
@Composable
internal fun Setup(setup: TulaAuthSetupContent, theme: TulaComposeTheme) {
    val matrix: TulaQrMatrix? = remember(setup.uri) {
        try {
            TulaQr.encode(setup.uri)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
    Sentence(setup.instruction, theme)
    matrix?.let { code ->
        Canvas(
            modifier = Modifier
                .size(QR_SIZE)
                .background(Color.White)
                .semantics { contentDescription = setup.qrLabel }
                .testTag("tula.qr"),
        ) {
            val cell = size.minDimension / (code.size + QUIET_ZONE * 2)
            for (y in 0 until code.size) {
                for (x in 0 until code.size) {
                    if (code.isDark(x, y)) {
                        // A hair wider than a cell, so that no seam shows between two of them.
                        drawRect(
                            color = Color.Black,
                            topLeft = Offset((x + QUIET_ZONE) * cell, (y + QUIET_ZONE) * cell),
                            size = Size(cell + 0.5f, cell + 0.5f),
                        )
                    }
                }
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(theme.spacing / 4)) {
        BasicText(
            text = setup.keyLabel,
            style = TextStyle(color = theme.colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamily, fontWeight = FontWeight.Medium),
        )
        BasicText(
            text = setup.key,
            modifier = Modifier.testTag("tula.setup.key"),
            style = TextStyle(color = theme.colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamilyMono),
        )
        BasicText(
            text = setup.keyHint,
            style = TextStyle(color = theme.colors.textMuted, fontSize = theme.fontSizeSmall, fontFamily = theme.fontFamily),
        )
    }
}

/** Backup codes, a line each. */
@Composable
internal fun Codes(codes: TulaAuthCodesContent, theme: TulaComposeTheme) {
    val shape = RoundedCornerShape(theme.radiusSmall)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(theme.colors.surface)
            .border(1.dp, theme.colors.border, shape)
            .padding(theme.spacing * 0.75f)
            .testTag("tula.codes"),
        verticalArrangement = Arrangement.spacedBy(theme.spacing / 4),
    ) {
        BasicText(
            text = codes.label,
            style = TextStyle(color = theme.colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamily, fontWeight = FontWeight.Medium),
        )
        codes.codes.forEachIndexed { index, code ->
            BasicText(
                text = code,
                modifier = Modifier.testTag("tula.codes.$index"),
                style = TextStyle(color = theme.colors.text, fontSize = theme.fontSize, fontFamily = theme.fontFamilyMono),
            )
        }
    }
}
