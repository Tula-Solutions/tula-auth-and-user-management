import { themeToCssVariables } from '@tula-tech/contract/theme'
import { type PlaygroundConfig, type Screen, themeOverrides } from './config'
import { PROVIDER_NAMES, type SandboxProvider } from './sandbox'

// The code a visitor copies, written from the same configuration the live component renders.
// Three outputs: the React component, the CSS custom properties that changed, and the
// `tula.config.ts` that sets the environment the same way. No colour or secret is invented:
// a secret is `env('NAME')`, as the real config file requires.

/** A secret reference as `@tula-tech/config`'s `env()` makes it. */
export interface EnvRef {
  $env: string
}

/** The `settings` and `providers` of one environment of `tula.config.ts`. */
export interface GeneratedEnvironment {
  kind: 'development'
  settings: Record<string, unknown>
  providers: Record<string, Record<string, string | EnvRef>>
}

/** Where the generated code says the app's pages live. */
export const APP_PATHS = {
  oauthCallback: '/auth/callback',
  emailLink: '/auth/email-link',
  afterSignIn: '/app',
  signIn: '/sign-in',
  signUp: '/sign-up',
  organizations: '/organizations',
  organizationProfile: '/organization',
  createOrganization: '/organization/new',
}

const COMPONENTS: Record<Screen, { component: string; page: string }> = {
  'sign-in': { component: 'SignIn', page: 'SignInPage' },
  'sign-up': { component: 'SignUp', page: 'SignUpPage' },
  account: { component: 'UserProfile', page: 'AccountPage' },
  'organization-switcher': { component: 'OrganizationSwitcher', page: 'OrganizationsPage' },
  'create-organization': { component: 'CreateOrganization', page: 'CreateOrganizationPage' },
  'organization-profile': { component: 'OrganizationProfile', page: 'OrganizationProfilePage' },
}

function secretName(provider: SandboxProvider): string {
  return `${provider.toUpperCase()}_CLIENT_SECRET`
}

/**
 * The environment settings the configuration stands for, as `tula.config.ts` writes them.
 *
 * @param config - The playground's configuration.
 * @returns One environment: its settings and the OAuth providers it manages.
 */
export function environmentOf(config: PlaygroundConfig): GeneratedEnvironment {
  const { settings } = config
  const providers: GeneratedEnvironment['providers'] = {}
  for (const provider of settings.oauth) {
    if (provider === 'apple') {
      providers.apple = {
        clientId: 'com.example.web',
        teamId: 'ABCDE12345',
        keyId: 'KEYID12345',
        privateKey: { $env: 'APPLE_PRIVATE_KEY' },
      }
    } else if (provider === 'microsoft') {
      providers.microsoft = {
        clientId: 'your-microsoft-client-id',
        clientSecret: { $env: secretName(provider) },
        tenant: 'common',
      }
    } else {
      providers[provider] = {
        clientId: `your-${provider}-client-id`,
        clientSecret: { $env: secretName(provider) },
      }
    }
  }
  const out: Record<string, unknown> = {
    app: { name: settings.appName },
    signIn: {
      methods: {
        password: { enabled: settings.methods.password },
        emailCode: { enabled: settings.methods.emailCode },
        emailLink: { enabled: settings.methods.emailLink },
        passkey: { enabled: settings.methods.passkey },
      },
    },
    signUp: { password: settings.signUpPassword },
    mfa: { policy: settings.mfaPolicy },
  }
  if (settings.organizations) {
    out.organizations = { enabled: true }
  }
  if (settings.methods.passkey) {
    out.passkeys = { rpId: 'localhost' }
  }
  const redirects: string[] = []
  if (settings.methods.emailLink) {
    redirects.push(`http://localhost:3000${APP_PATHS.emailLink}`)
  }
  if (settings.oauth.length) {
    redirects.push(`http://localhost:3000${APP_PATHS.oauthCallback}`)
  }
  if (redirects.length || settings.methods.passkey) {
    out.urls = { allowedOrigins: ['http://localhost:3000'], allowedRedirectUrls: redirects }
  }
  return { kind: 'development', settings: out, providers }
}

function literal(value: unknown, depth: number): string {
  const pad = '  '.repeat(depth)
  const inner = '  '.repeat(depth + 1)
  if (value !== null && typeof value === 'object' && '$env' in value) {
    return `env('${(value as EnvRef).$env}')`
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) {
      return `[${value.map((item) => `'${item}'`).join(', ')}]`
    }
    return `[\n${value.map((item) => `${inner}${literal(item, depth + 1)},`).join('\n')}\n${pad}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (!entries.length) {
      return '{}'
    }
    return `{\n${entries
      .map(
        ([key, item]) =>
          `${inner}${/^[a-z_$][\w$]*$/i.test(key) ? key : `'${key}'`}: ${literal(item, depth + 1)},`
      )
      .join('\n')}\n${pad}}`
  }
  if (typeof value === 'string') {
    // The backslash first: the quote's own escape must not be escaped again.
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  }
  return String(value)
}

/**
 * The `tula.config.ts` that sets an environment the way the sandbox is set.
 *
 * @param config - The playground's configuration.
 * @returns The file's text.
 */
export function configTs(config: PlaygroundConfig): string {
  const { settings, providers } = environmentOf(config)
  const uses = Object.keys(providers).length > 0
  const lines = [
    `import { defineConfig${uses ? ', env' : ''} } from '@tula-tech/config'`,
    '',
    'export default defineConfig({',
    '  environments: {',
    '    dev: {',
    "      kind: 'development',",
    `      settings: ${literal(settings, 3)},`,
  ]
  if (uses) {
    lines.push(`      providers: ${literal(providers, 3)},`)
  }
  lines.push('    },', '  },', '})', '')
  return lines.join('\n')
}

/**
 * The CSS custom properties the configuration changes, or a note when nothing changed.
 *
 * @param config - The playground's configuration.
 * @returns A stylesheet rule.
 */
export function cssBlock(config: PlaygroundConfig): string {
  const variables = themeToCssVariables(themeOverrides(config))
  const entries = Object.entries(variables)
  if (!entries.length) {
    return '/* Nothing changed: the components use the default theme. */\n'
  }
  return `:root {\n${entries.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`
}

function appearanceProp(config: PlaygroundConfig, indent: string): string | null {
  const theme = themeOverrides(config)
  if (!Object.keys(theme).length) {
    return null
  }
  const body = literal({ theme }, 0)
    .split('\n')
    .map((line, at) => (at === 0 ? line : `${indent}${line}`))
    .join('\n')
  return `appearance={${body}}`
}

/**
 * The React page that renders the configured component.
 *
 * @param config - The playground's configuration.
 * @returns The file's text.
 */
export function jsx(config: PlaygroundConfig): string {
  const { component, page } = COMPONENTS[config.screen]
  const { settings } = config
  const props: string[] = []
  if (config.screen === 'sign-in') {
    props.push(`signUpUrl='${APP_PATHS.signUp}'`)
  } else if (config.screen === 'sign-up') {
    props.push(`signInUrl='${APP_PATHS.signIn}'`)
  } else if (config.screen === 'organization-switcher') {
    props.push(
      `organizationProfileUrl='${APP_PATHS.organizationProfile}'`,
      `createOrganizationUrl='${APP_PATHS.createOrganization}'`
    )
  } else if (config.screen === 'create-organization') {
    props.push(`afterCreateUrl='${APP_PATHS.organizations}'`)
  } else if (config.screen === 'organization-profile') {
    props.push(
      `invitationUrl='${APP_PATHS.organizations}'`,
      `afterLeaveUrl='${APP_PATHS.organizations}'`,
      `afterDeleteUrl='${APP_PATHS.organizations}'`
    )
  } else {
    props.push(`afterSignOutUrl='${APP_PATHS.signIn}'`)
  }
  const appearance = appearanceProp(config, '        ')
  if (appearance) {
    props.push(appearance)
  }
  const provider: string[] = [
    'publishableKey={import.meta.env.VITE_TULA_PUBLISHABLE_KEY}',
    "baseUrl='https://auth.example.com'",
    `afterSignInUrl='${APP_PATHS.afterSignIn}'`,
  ]
  if (settings.oauth.length) {
    provider.push(`oauthCallbackUrl='${APP_PATHS.oauthCallback}'`)
  }
  if (settings.methods.emailLink) {
    provider.push(`emailLinkUrl='${APP_PATHS.emailLink}'`)
  }
  const callbacks = [
    settings.oauth.length ? 'OAuthCallback' : null,
    settings.methods.emailLink ? 'EmailLinkCallback' : null,
  ].filter((name): name is string => name !== null)
  const imports = [component, ...callbacks, 'TulaProvider'].sort()
  const lines = [
    `import { ${imports.join(', ')} } from '@tula-tech/react'`,
    "import '@tula-tech/react/styles.css'",
    '',
    `export function ${page}() {`,
    '  return (',
    '    <TulaProvider',
    ...provider.map((prop) => `      ${prop}`),
    '    >',
    `      <${component}`,
    ...props.map((prop) => `        ${prop}`),
    '      />',
    '    </TulaProvider>',
    '  )',
    '}',
    '',
  ]
  for (const callback of callbacks) {
    lines.push(
      `// Mount this at ${callback === 'OAuthCallback' ? APP_PATHS.oauthCallback : APP_PATHS.emailLink}:`,
      `export function ${callback}Page() {`,
      '  return (',
      '    <TulaProvider',
      ...provider.map((prop) => `      ${prop}`),
      '    >',
      `      <${callback} />`,
      '    </TulaProvider>',
      '  )',
      '}',
      ''
    )
  }
  return lines.join('\n')
}

/** The provider's display name, for the labels beside the code. */
export function providerLabel(provider: SandboxProvider): string {
  return PROVIDER_NAMES[provider]
}
