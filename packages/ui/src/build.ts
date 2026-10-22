import { checkSource, importsOf, type Refusal } from './checks'
import {
  ITEM_VERSION,
  ITEMS,
  type ItemDefinition,
  itemNamed,
  MIN_REACT,
  REGISTRY,
  SHADCN,
} from './registry'
import { themeItemBody } from './theme-item'

/**
 * The registry build: from `ITEMS` and the sources under `items/`, the JSON a shadcn client
 * installs from. One file per item, and `registry.json`, the index.
 *
 * `generate` writes them; `check` fails when what is on disk is not what the sources would
 * write, so a change to a source, to the theme in `@tula-tech/contract/theme` or to this
 * build cannot be merged without its built output (the pattern of `docs:check`).
 */

/** What a build is given: where sources are read from, and where the registry will be served. */
export interface BuildOptions {
  /** The text of a file under `items/`, by its name. */
  read(source: string): string
  /** The address `<name>.json` is served at, without a trailing slash. */
  baseUrl: string
}

/** One built file of the registry: its name under `r/` and its text. */
export interface Built {
  name: string
  text: string
}

/** The build refused an item. `refusals` lists every reason, by file. */
export class RegistryError extends Error {
  readonly refusals: ReadonlyArray<{ item: string; file: string } & Refusal>

  constructor(refusals: ReadonlyArray<{ item: string; file: string } & Refusal>) {
    super(
      `the registry build refused ${refusals.length === 1 ? 'a file' : `${refusals.length} things`}:\n${refusals
        .map(
          (entry) => `  ${entry.item}/${entry.file}:${entry.line} [${entry.rule}] ${entry.message}`
        )
        .join('\n')}`
    )
    this.name = 'RegistryError'
    this.refusals = refusals
  }
}

/** @returns The address of an item's JSON. */
export function itemUrl(baseUrl: string, name: string): string {
  return `${baseUrl}/${name}.json`
}

/**
 * Refuse a file that breaks a rule, or that imports something its item does not declare.
 *
 * @param item - The item.
 * @param options - Where to read sources.
 * @returns Every refusal of every file of the item.
 */
export function refusalsOf(
  item: ItemDefinition,
  options: Pick<BuildOptions, 'read'>
): Array<{ item: string; file: string } & Refusal> {
  const refusals: Array<{ item: string; file: string } & Refusal> = []
  for (const file of item.files) {
    const source = options.read(file.source)
    for (const refusal of checkSource(source)) {
      refusals.push({ item: item.name, file: file.source, ...refusal })
    }
    // What the file imports must be what the item declares: a copy that imports a primitive
    // or a sibling the manifest does not name would not compile in the app it was copied into.
    for (const specifier of importsOf(source)) {
      const declared = declaredFor(item, specifier)
      if (declared === 'undeclared') {
        refusals.push({
          item: item.name,
          file: file.source,
          rule: 'import-not-allowed',
          line: 1,
          message: `imports ${specifier} without declaring it in registryDependencies or dependencies`,
        })
      }
    }
  }
  return refusals
}

function declaredFor(item: ItemDefinition, specifier: string): 'ok' | 'undeclared' {
  const primitive = /^@\/components\/ui\/([\w-]+)$/.exec(specifier)?.[1]
  const sibling = /^@\/components\/tula\/([\w-]+)$/.exec(specifier)?.[1]
  if (primitive) {
    return item.registryDependencies.includes(primitive) ? 'ok' : 'undeclared'
  }
  if (sibling) {
    return item.registryDependencies.includes(sibling) || ownsFile(item, sibling)
      ? 'ok'
      : 'undeclared'
  }
  if (specifier === '@tula-tech/react') {
    return item.dependencies.some((entry) => entry.startsWith('@tula-tech/react'))
      ? 'ok'
      : 'undeclared'
  }
  // react, and `@/lib/utils`, which every shadcn app has.
  return 'ok'
}

function ownsFile(item: ItemDefinition, name: string): boolean {
  return item.files.some((file) => file.source === `${name}.tsx`)
}

/**
 * Build one item as shadcn's registry item JSON.
 *
 * @param item - The item.
 * @param options - Where to read sources and where the registry is served.
 * @returns The item as an object, ready to serialise.
 * @throws RegistryError when a file of the item breaks a rule.
 */
export function buildItem(item: ItemDefinition, options: BuildOptions): Record<string, unknown> {
  const refusals = refusalsOf(item, options)
  if (refusals.length > 0) {
    throw new RegistryError(refusals)
  }
  const body = item.type === 'registry:theme' ? themeItemBody() : {}
  return {
    $schema: SHADCN.itemSchemaUrl,
    name: item.name,
    type: item.type,
    title: item.title,
    description: item.description,
    ...(item.dependencies.length > 0 && { dependencies: [...item.dependencies] }),
    ...(item.registryDependencies.length > 0 && {
      registryDependencies: item.registryDependencies.map((name) =>
        itemNamed(name) ? itemUrl(options.baseUrl, name) : name
      ),
    }),
    ...body,
    ...(item.files.length > 0 && {
      files: item.files.map((file) => ({
        path: `items/${file.source}`,
        type: file.type,
        target: file.target,
        content: options.read(file.source),
      })),
    }),
    ...(item.docs && { docs: item.docs }),
    meta: { tula: { version: ITEM_VERSION, minReact: MIN_REACT, security: false } },
  }
}

/**
 * Put an array of one short string on one line, as the repository's formatter would.
 *
 * `biome check` reads the JSON under `r/`, so the build writes what the formatter would: this is
 * the one rule in which it differs from `JSON.stringify(…, null, 2)`.
 *
 * @param json - Text from `JSON.stringify(value, null, 2)`.
 * @returns The same text with `[\n  "x"\n]` written as `["x"]`.
 */
export function tidy(json: string): string {
  return json.replace(
    /^(\s*"[^"\n]+": )\[\n\s+("(?:[^"\\\n]|\\.)*")\n\s*\]/gm,
    (whole, key: string, item: string) =>
      key.length + item.length + 3 <= 100 ? `${key}[${item}]` : whole
  )
}

/**
 * Build the whole registry.
 *
 * @param options - Where to read sources and where the registry is served.
 * @returns `registry.json` and one file per item, in the order of `ITEMS`.
 * @throws RegistryError when any item breaks a rule.
 */
export function buildRegistry(options: BuildOptions): Built[] {
  const items = ITEMS.map((item) => buildItem(item, options))
  const index = {
    $schema: SHADCN.registrySchemaUrl,
    name: REGISTRY.name,
    homepage: REGISTRY.homepage,
    // The index lists what an item is, not its files' text: a client reads the item for that.
    items: items.map((item) => ({
      ...item,
      files: Array.isArray(item.files)
        ? (item.files as Array<Record<string, unknown>>).map(
            ({ content: _content, ...rest }) => rest
          )
        : undefined,
    })),
  }
  const serialise = (value: unknown) => `${tidy(JSON.stringify(value, null, 2))}\n`
  return [
    { name: 'registry.json', text: serialise(index) },
    ...items.map((item) => ({ name: `${String(item.name)}.json`, text: serialise(item) })),
  ]
}

/**
 * Compare what a build writes with what is on disk.
 *
 * @param built - The files a build writes.
 * @param onDisk - The text of a file under `r/`, or `null` when it is not there.
 * @param present - The names of every `.json` file under `r/` now.
 * @returns A line per difference: a file that is out of date, missing or no longer an item.
 */
export function drift(
  built: readonly Built[],
  onDisk: (name: string) => string | null,
  present: readonly string[]
): string[] {
  const problems: string[] = []
  for (const file of built) {
    const text = onDisk(file.name)
    if (text === null) {
      problems.push(`${file.name} is missing`)
    } else if (text !== file.text) {
      problems.push(`${file.name} is out of date`)
    }
  }
  const expected = new Set(built.map((file) => file.name))
  for (const name of present) {
    if (!expected.has(name)) {
      problems.push(`${name} is not an item of the registry any more`)
    }
  }
  return problems
}
