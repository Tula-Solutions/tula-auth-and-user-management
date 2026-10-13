import type { TulaError } from '@tula/expo'
import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

// The app's own controls. `@tula/expo` draws nothing: every screen here belongs to the app.

/** A screen's frame: a title, then whatever the screen holds. */
export function Screen(props: { title: string; children: ReactNode }) {
  return (
    <View style={styles.screen}>
      <Text accessibilityRole='header' style={styles.title}>
        {props.title}
      </Text>
      {props.children}
    </View>
  )
}

/** A labelled text field. */
export function Field(props: {
  label: string
  value: string
  onChangeText(value: string): void
  /** What the keyboard and the password manager are told the field holds. */
  kind: 'email' | 'password' | 'new-password' | 'code' | 'text'
}) {
  const secret = props.kind === 'password' || props.kind === 'new-password'
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        autoCapitalize='none'
        autoCorrect={false}
        keyboardType={
          props.kind === 'email'
            ? 'email-address'
            : props.kind === 'code'
              ? 'number-pad'
              : 'default'
        }
        secureTextEntry={secret}
        textContentType={
          props.kind === 'email'
            ? 'username'
            : props.kind === 'password'
              ? 'password'
              : props.kind === 'new-password'
                ? 'newPassword'
                : props.kind === 'code'
                  ? 'oneTimeCode'
                  : 'none'
        }
        style={styles.input}
        value={props.value}
        onChangeText={props.onChangeText}
      />
    </View>
  )
}

/** A button that says when its action is under way and cannot be pressed twice. */
export function Action(props: {
  label: string
  onPress(): void
  pending?: boolean
  quiet?: boolean
}) {
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ busy: props.pending === true, disabled: props.pending === true }}
      disabled={props.pending === true}
      onPress={props.onPress}
      style={props.quiet ? styles.quiet : styles.button}
    >
      {props.pending ? (
        <ActivityIndicator />
      ) : (
        <Text style={props.quiet ? styles.quietText : styles.buttonText}>{props.label}</Text>
      )}
    </Pressable>
  )
}

/** What went wrong, in the words `@tula/core` has for the error's code. */
export function Problem(props: { error: TulaError | null }) {
  if (!props.error) {
    return null
  }
  return (
    <Text accessibilityRole='alert' style={styles.problem}>
      {props.error.message}
    </Text>
  )
}

/** A line of plain text. */
export function Note(props: { children: ReactNode }) {
  return <Text style={styles.note}>{props.children}</Text>
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 12, padding: 24, paddingTop: 72 },
  title: { fontSize: 24, fontWeight: '600' },
  field: { gap: 4 },
  label: { fontSize: 14 },
  input: { borderColor: '#767676', borderRadius: 8, borderWidth: 1, fontSize: 16, padding: 12 },
  button: { alignItems: 'center', backgroundColor: '#1f4fd8', borderRadius: 8, padding: 14 },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  quiet: { alignItems: 'center', padding: 12 },
  quietText: { color: '#1f4fd8', fontSize: 16 },
  problem: { color: '#b00020', fontSize: 14 },
  note: { fontSize: 14 },
})
