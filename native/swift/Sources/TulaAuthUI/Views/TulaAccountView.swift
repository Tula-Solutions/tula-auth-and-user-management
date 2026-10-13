import SwiftUI
import TulaAuth

/// The signed-in user's account, as a screen: who they are, where they are signed in, their
/// second step, their phone number and their passkeys.
///
/// ```swift
/// TulaAccountView(client: tula) {
///     // Nobody is signed in any more: show the sign-in.
/// }
/// ```
///
/// The view draws what its model holds (`TulaAccountModel.content`) and decides nothing.
/// When the server asks for proof that it is the user, the screen asks for it itself and
/// then does what was asked for.
///
/// **It holds no token**, and a password, a code, a setup key or backup codes only while
/// their form is open. When the view goes away its forms are closed and emptied.
///
/// **A failed sign-out is not a sign-out**: `onSignedOut` is called only once the server
/// was told; otherwise the screen stays and says that the session may still be active.
///
/// A passkey is added, and used for the step-up, through the sheet the app gave its
/// client; an app that gave none is told in words that passkeys cannot be created here.
public struct TulaAccountView: View {
    @StateObject private var model: TulaAccountModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.tulaAuthSlots) private var slots
    @FocusState private var focused: TulaAuthField?
    @AccessibilityFocusState private var spoken: TulaAuthFocus?

    private let theme: TulaResolvedTheme

    /// - Parameters:
    ///   - client: The app's client, signed in.
    ///   - theme: The theme, as strings; every value is checked and a refused one is
    ///     replaced by the default (`TulaResolvedTheme`).
    ///   - strings: The strings.
    ///   - onSignedOut: Called when nobody is signed in any more. Never after a sign-out
    ///     that failed.
    public init(
        client: TulaClient,
        theme: TulaTheme = .defaults,
        strings: TulaStrings = .english,
        onSignedOut: (@MainActor () -> Void)? = nil
    ) {
        self.init(
            model: TulaAccountModel(
                client: client, strings: strings, announce: Announcer.say, copy: Pasteboard.copy,
                onSignedOut: onSignedOut),
            theme: TulaResolvedTheme(theme))
    }

    /// Draw a model the app made itself, with a theme it already resolved.
    ///
    /// - Parameters:
    ///   - model: The model. The view owns it from here on: it closes it when it goes away.
    ///   - theme: A resolved theme.
    public init(model: @autoclosure @escaping () -> TulaAccountModel, theme: TulaResolvedTheme = .defaults) {
        _model = StateObject(wrappedValue: model())
        self.theme = theme
    }

    /// The open panel, drawn from the model's content.
    public var body: some View {
        let appearance = TulaAuthAppearance(theme: theme, colorScheme: colorScheme)
        let unit = appearance.theme.spacing
        let content = model.content
        ScrollView {
            VStack(spacing: unit * 1.5) {
                titles(content, appearance)
                MessagesView(problem: model.formProblem, status: model.status, notice: model.notice)
                ForEach(content.sections, id: \.identifier) { section in
                    self.section(section, appearance)
                }
                form(content, appearance)
            }
            .padding(.horizontal, unit * 1.5)
            .padding(.vertical, unit * 2)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(appearance.colors.background.color.ignoresSafeArea())
        .environment(\.tulaAuthAppearance, appearance)
        .task { await model.load() }
        .onReceive(model.$focusRequests.dropFirst()) { _ in moveFocus() }
        .onDisappear { model.close() }
    }

    private func moveFocus() {
        Task { @MainActor in
            let target = model.focus
            if case .field(let field) = target {
                focused = field
            } else {
                focused = nil
            }
            spoken = target
        }
    }

    private func run(_ action: TulaAccountAction) {
        Task { @MainActor in await model.perform(action) }
    }

    private func text(of field: TulaAuthField) -> Binding<String> {
        Binding(get: { model.text(of: field) }, set: { model.setText($0, of: field) })
    }

    private func titles(_ content: TulaAccountContent, _ appearance: TulaAuthAppearance) -> some View {
        VStack(spacing: appearance.theme.spacing * 0.5) {
            Text(content.title)
                .themed(.title, appearance, weight: .bold)
                .foregroundColor(appearance.colors.text.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($spoken, equals: .title)
                .accessibilityIdentifier("tula.title")
            if let subtitle = content.subtitle {
                Text(subtitle)
                    .themed(.body, appearance)
                    .foregroundColor(appearance.colors.textMuted.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("tula.subtitle")
            }
        }
    }

    /// The open form, or, on the account itself, its last links.
    private func form(_ content: TulaAccountContent, _ appearance: TulaAuthAppearance) -> some View {
        let run: (TulaAccountAction) -> Void = { self.run($0) }
        return VStack(spacing: appearance.theme.spacing) {
            if let setup = content.setup {
                SetupView(content: setup, run: run)
            }
            ForEach(content.fields, id: \.field) { field in
                AuthField(
                    content: field, text: text(of: field.field), errors: model.problems(of: field.field),
                    spokenLabel: model.spokenLabel(of: field), strings: model.strings, focus: $focused,
                    spoken: $spoken, revealed: model.isRevealed(field.field),
                    onReveal: { model.toggleReveal(field.field) }, onSubmit: { run(field.submit) })
            }
            if let codes = content.codes {
                CodesView(content: codes, run: run)
            }
            if let primary = content.primary {
                PrimaryButton(offer: primary, isPending: model.isPending, loading: model.strings.loading, run: run)
            }
            ForEach(content.links, id: \.identifier) { link in
                OfferView(offer: link, run: run)
            }
        }
    }

    /// One part of the account: its heading, what is said under it, its list, its buttons.
    private func section(_ section: TulaAccountSection, _ appearance: TulaAuthAppearance) -> some View {
        let colors = appearance.colors
        let unit = appearance.theme.spacing
        return VStack(alignment: .leading, spacing: unit * 0.5) {
            Text(section.title)
                .themed(.body, appearance, weight: .bold)
                .foregroundColor(colors.text.color)
                .accessibilityAddTraits(.isHeader)
            if !section.lines.isEmpty {
                VStack(alignment: .leading, spacing: unit * 0.5) {
                    ForEach(section.lines, id: \.self) { line in
                        Text(line)
                            .themed(.body, appearance)
                            .foregroundColor(colors.textMuted.color)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                // One thing for VoiceOver ("maya@example.com, Verified"): an address or a
                // number read alone says nothing of what it is.
                .accessibilityElement(children: .combine)
            }
            ForEach(section.rows, id: \.identifier) { row in
                self.row(row, appearance)
            }
            ForEach(section.offers, id: \.identifier) { offer in
                LinkButton(
                    title: offer.title, identifier: offer.identifier, spoken: offer.spoken,
                    destructive: offer.destructive
                ) { run(offer.action) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(unit)
        .background(
            RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous).fill(colors.input.color)
        )
        .overlay(
            RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous)
                .strokeBorder(colors.borderStrong.color, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(section.identifier)
    }

    /// A session or a passkey: what it is, what marks it (in words), and what can be done.
    private func row(_ row: TulaAccountRow, _ appearance: TulaAuthAppearance) -> some View {
        let colors = appearance.colors
        return VStack(alignment: .leading, spacing: appearance.theme.spacing * 0.25) {
            VStack(alignment: .leading, spacing: appearance.theme.spacing * 0.25) {
                Text(row.title)
                    .themed(.body, appearance, weight: .semibold)
                    .foregroundColor(colors.text.color)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(row.marks, id: \.self) { mark in
                    Text(mark)
                        .themed(.small, appearance, weight: .semibold)
                        .foregroundColor(colors.text.color)
                }
                ForEach(row.details, id: \.self) { detail in
                    Text(detail)
                        .themed(.small, appearance)
                        .foregroundColor(colors.textMuted.color)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            // One thing for VoiceOver: "iPhone or iPad app, This device, Signed in …".
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(row.identifier)
            HStack(spacing: appearance.theme.spacing) {
                ForEach(row.offers, id: \.identifier) { offer in
                    LinkButton(
                        title: offer.title, identifier: offer.identifier, spoken: offer.spoken,
                        destructive: offer.destructive
                    ) { run(offer.action) }
                }
            }
        }
        .padding(.top, appearance.theme.spacing * 0.5)
    }
}
