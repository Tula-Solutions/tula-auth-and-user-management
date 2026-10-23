/**
 * What the registry is: its name, the shadcn schema it is written against, and the items it
 * holds. Everything the build writes comes from here and from the sources under `items/`.
 */

/**
 * The shadcn registry format this registry is written against, pinned (ADR 0064). The two JSON
 * Schemas are vendored in `schema/` as they were served on the day the CLI below was current,
 * and their hashes are here: a test fails when either file changes, so a move to a newer
 * format is a decision with a diff, never a download.
 */
export const SHADCN = {
  /** The `shadcn` CLI release the registry was checked against by installing from it. */
  cli: '4.22.1',
  itemSchemaUrl: 'https://ui.shadcn.com/schema/registry-item.json',
  itemSchemaSha256: 'cdf0fba75a26ebf594018264eff2d55407ec14deb3071d0fce0e2b20848e5d44',
  registrySchemaUrl: 'https://ui.shadcn.com/schema/registry.json',
  registrySchemaSha256: 'e716ebe595bbc189db2627cb75f0484cd765a09eb397a89b1f1c49074220d4bb',
} as const

/** The registry's name (the shadcn "style" it ships is `tula`) and where its pages live. */
export const REGISTRY = {
  name: 'tula',
  homepage: 'https://tula-solutions.github.io/tula-auth-and-user-management/',
  /**
   * Where the built JSON is served, until the docs site serves it itself (TULA-94): items name
   * each other by this address, because a registry dependency that is not a shadcn primitive is
   * a URL. `registry:generate --base-url` builds for another address, to try an install from a
   * local server.
   */
  baseUrl: 'https://tula-solutions.github.io/tula-auth-and-user-management/r',
} as const

/** The file types shadcn gives a registry file. */
export type FileType = 'registry:component' | 'registry:ui' | 'registry:lib' | 'registry:hook'

/** One file of an item: where its source is, and where shadcn writes it in the app. */
export interface ItemFile {
  /** The source, relative to `items/`. */
  source: string
  type: FileType
  /**
   * Where the file lands in the app. `@components/` is the app's own `components` alias
   * (shadcn resolves it from `components.json`), so the item does not guess a folder.
   */
  target: string
}

/** The item types of this registry. */
export type ItemType = 'registry:component' | 'registry:block' | 'registry:theme'

/** One item of the registry, before it is built. */
export interface ItemDefinition {
  name: string
  type: ItemType
  title: string
  description: string
  files: readonly ItemFile[]
  /**
   * What the item needs from shadcn's registry (`button`, `input`) and from this one (a name
   * that is another item of this registry: the build turns it into that item's address).
   */
  registryDependencies: readonly string[]
  /** What the item needs from npm. `@tula-tech/react` is the only package a Tula item may need. */
  dependencies: readonly string[]
  /** What the CLI prints after the install. */
  docs?: string
}

/**
 * The `@tula-tech/react` release whose headless layer the items are written against
 * (`StepRenderer`, `firstFactorStrategies` and the hooks of ADR 0064). Items state it as the
 * minimum, because an older package does not export what they import.
 */
export const MIN_REACT = '0.2.0'

/**
 * The release that last changed each item (ADR 0064: an item's version is the release that last
 * changed it). All three are new in the release that carries the headless layer.
 */
export const ITEM_VERSION = '0.2.0'

/** The npm dependency every item that draws a flow has. */
const REACT = `@tula-tech/react@^${MIN_REACT}`

/**
 * Every item, in the order the index lists them: the theme and the primitives first, then the
 * blocks that use them.
 */
export const ITEMS: readonly ItemDefinition[] = [
  {
    name: 'theme',
    type: 'registry:theme',
    title: 'Tula theme',
    description:
      "Maps Tula's theme tokens (--tula-*) to shadcn's variables, in light and dark: ink and paper neutrals, an ink primary button, violet only for links and focus, 10px corners. Follows the .dark class and data-tula-theme. Optional: Tula's components use only shadcn's own variables, so an app with a theme of its own keeps it.",
    files: [],
    registryDependencies: [],
    dependencies: [],
    docs: 'Set --tula-* properties (or use themeToCssVariables from @tula-tech/contract/theme for a tenant\'s brand) on an element above the components to change a token. Light and dark follow the .dark class or data-tula-theme="dark" on an ancestor.',
  },
  {
    name: 'step-card',
    type: 'registry:component',
    title: 'Step card',
    description:
      "One screen of a flow: a titled card with a description, a footer and a title that takes the focus when the screen changes. Drawn from the app's own shadcn tokens.",
    files: [
      {
        source: 'step-card.tsx',
        type: 'registry:component',
        target: '@components/tula/step-card.tsx',
      },
    ],
    registryDependencies: ['card'],
    dependencies: [REACT],
  },
  {
    name: 'status',
    type: 'registry:component',
    title: 'Status',
    description:
      'A quiet status line (polite, never an alert) and the alert above a form for a failure that is not about one field. The state is in the words, not only the colour.',
    files: [
      {
        source: 'status.tsx',
        type: 'registry:component',
        target: '@components/tula/status.tsx',
      },
    ],
    registryDependencies: [],
    dependencies: [],
  },
  {
    name: 'sign-in',
    type: 'registry:block',
    title: 'Sign in (password)',
    description:
      'Email, then password, drawn from the step the server is waiting for. An unknown step is shown as "not supported", never as a blank card. Behaviour and security live in @tula-tech/react; this is presentation you own.',
    files: [
      {
        source: 'sign-in.tsx',
        type: 'registry:component',
        target: '@components/tula/sign-in.tsx',
      },
    ],
    registryDependencies: ['button', 'input', 'label', 'step-card', 'status'],
    dependencies: [REACT],
    docs: 'Draw <SignIn onComplete={...} /> inside <TulaProvider> from @tula-tech/react. Import "@tula-tech/react/styles.css" once for the one screen the package draws itself, the "not supported" fallback.',
  },
]

/** @returns The item with this name, or `undefined`. */
export function itemNamed(name: string): ItemDefinition | undefined {
  return ITEMS.find((item) => item.name === name)
}
