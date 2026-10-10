// For the repository's own typecheck of the example only (`tsconfig.json` beside this file).
//
// The repository installs neither Expo nor React Native, so these are the members of the two
// packages the app uses, declared no further than it uses them. They are loose on purpose
// (a style is any record): what they catch is a mistake in how the app calls `@tula/expo`,
// which is checked against that package's real sources. An installed copy of the app is
// checked against the real declarations (`app/tsconfig.json`); `README.md` says when that
// was last done.

declare module 'react-native' {
  import type { ComponentType, ReactNode } from 'react'

  type Style = Record<string, string | number> | false | null | undefined
  interface Accessible {
    accessibilityLabel?: string
    accessibilityRole?: 'alert' | 'button' | 'header'
    accessibilityState?: { busy?: boolean; disabled?: boolean }
  }

  export const View: ComponentType<Accessible & { style?: Style; children?: ReactNode }>
  export const Text: ComponentType<Accessible & { style?: Style; children?: ReactNode }>
  export const ActivityIndicator: ComponentType<Accessible>
  export const Pressable: ComponentType<
    Accessible & { style?: Style; children?: ReactNode; disabled?: boolean; onPress?(): void }
  >
  export const TextInput: ComponentType<
    Accessible & {
      style?: Style
      value?: string
      onChangeText?(value: string): void
      autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'
      autoCorrect?: boolean
      keyboardType?: 'default' | 'email-address' | 'number-pad'
      secureTextEntry?: boolean
      textContentType?: 'none' | 'username' | 'password' | 'newPassword' | 'oneTimeCode'
    }
  >
  export const StyleSheet: {
    create<T extends Record<string, Record<string, string | number>>>(styles: T): T
  }
}

declare module 'expo' {
  import type { ComponentType } from 'react'

  /** Registers the app's root component with React Native. */
  export function registerRootComponent(component: ComponentType): void
}

/** Expo replaces `process.env.EXPO_PUBLIC_*` in the bundle with the value at build time. */
declare const process: { env: Record<string, string | undefined> }
