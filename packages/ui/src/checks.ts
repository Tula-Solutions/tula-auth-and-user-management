import { ts } from 'ts-morph'

/**
 * The refusals of the registry build (ADR 0064, `.claude/rules/tula-ui.md`): what a file of an
 * item may not contain, because a copied file is presentation only. The check is a source scan,
 * a guard against an honest mistake and not against an author who means harm: the registry's
 * files are reviewed like any other, and what is built at run time or hidden behind an alias is
 * for that review.
 */

/** The rules, by the name a refusal carries. */
export const RULES = [
  'imports-core',
  'client-sign-out',
  'global-in-render',
  'inner-html',
  'console',
  'hard-coded-string',
  'import-not-allowed',
] as const

export type Rule = (typeof RULES)[number]

/** One thing the build refuses, with where it is. */
export interface Refusal {
  rule: Rule
  /** 1-based. */
  line: number
  /** What the rule says, for the person fixing it. */
  message: string
}

/** The globals a render may not touch: they do not exist on a server, and differ on hydration. */
const BROWSER_GLOBALS = new Set([
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
])

/** Property names that write markup from a string. */
const HTML_SINKS = new Set([
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
])

/** JSX attributes whose value a user reads or hears. */
const VISIBLE_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'alt',
  'placeholder',
  'label',
  'summary',
  // The items' own props that carry words: StepCard, Status, FormAlert and the like.
  'description',
  'message',
  'detail',
  'text',
  'heading',
  'caption',
  'helperText',
  'hint',
])

/** What an item may import: React, the headless package, shadcn's primitives and its siblings. */
const ALLOWED_IMPORT =
  /^(?:react(?:\/jsx-runtime)?|@tula-tech\/react|@\/components\/ui\/[\w-]+|@\/components\/tula\/[\w-]+|@\/lib\/utils)$/

const HOOKS_OF_EFFECTS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect'])

const LETTER = /\p{L}/u

function hasLetters(text: string): boolean {
  return LETTER.test(text)
}

/**
 * What a file imports, as module specifiers.
 *
 * @param source - The file's text.
 * @returns The specifiers of its `import` and `export … from` statements, in order.
 */
export function importsOf(source: string): string[] {
  const file = ts.createSourceFile(
    'item.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const found: string[] = []
  const visit = (node: ts.Node) => {
    const specifier = specifierOf(node)
    if (specifier !== null) {
      found.push(specifier)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The module a node names, for an import or re-export, a `require` or a dynamic `import()`. */
function specifierOf(node: ts.Node): string | null {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text
  }
  if (ts.isCallExpression(node)) {
    const [first] = node.arguments
    const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
    const required = ts.isIdentifier(node.expression) && node.expression.text === 'require'
    if ((dynamic || required) && first && ts.isStringLiteralLike(first)) {
      return first.text
    }
  }
  return null
}

/**
 * Scan one file of an item.
 *
 * @param source - The file's text (TSX).
 * @returns Every refusal, in the order of the source; empty when the file is acceptable.
 *
 * @example
 * ```ts
 * checkSource("console.log('x')") // [{ rule: 'console', line: 1, message: '…' }]
 * ```
 */
export function checkSource(source: string): Refusal[] {
  const file = ts.createSourceFile(
    'item.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const refusals: Refusal[] = []
  const refuse = (node: ts.Node, rule: Rule, message: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    refusals.push({ rule, line: line + 1, message })
  }

  const visit = (node: ts.Node) => {
    const specifier = specifierOf(node)
    if (specifier !== null) {
      if (/^@tula-tech\/core(?:\/|$)/.test(specifier)) {
        refuse(
          node,
          'imports-core',
          `imports ${specifier}: a copy reaches the API only through @tula-tech/react's hooks`
        )
      } else if (!ALLOWED_IMPORT.test(specifier)) {
        refuse(
          node,
          'import-not-allowed',
          `imports ${specifier}: an item imports only react, @tula-tech/react, shadcn primitives, its siblings and @/lib/utils`
        )
      }
    }
    if (isClientSignOut(node) || isDestructuredClientSignOut(node)) {
      refuse(
        node,
        'client-sign-out',
        "signs out on the client: sign out through the provider's `signOut` (useAuth), so that a failed sign-out is not taken for one"
      )
    }
    if (ts.isIdentifier(node) && isGlobalReference(node)) {
      if (node.text === 'console') {
        refuse(node, 'console', 'calls console: items log nothing')
      } else if (BROWSER_GLOBALS.has(node.text) && !inLaterWork(node)) {
        refuse(
          node,
          'global-in-render',
          `reads ${node.text} during render: do it in an effect or an event handler (a server has none)`
        )
      }
    }
    if (isHtmlSink(node)) {
      refuse(node, 'inner-html', 'writes markup from a string: a string is rendered as text')
    }
    if (ts.isJsxText(node) && hasLetters(node.text)) {
      refuse(
        node,
        'hard-coded-string',
        `hard-codes "${node.text.trim()}": words come from useLocalization()`
      )
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const literal of visibleLiterals(node.expression)) {
        refuse(
          literal.node,
          'hard-coded-string',
          `hard-codes "${literal.text.trim()}": words come from useLocalization()`
        )
      }
    }
    if (
      ts.isJsxAttribute(node) &&
      VISIBLE_ATTRIBUTES.has(attributeName(node)) &&
      node.initializer
    ) {
      const values: Literal[] = ts.isStringLiteral(node.initializer)
        ? hasLetters(node.initializer.text)
          ? [{ node: node.initializer, text: node.initializer.text }]
          : []
        : ts.isJsxExpression(node.initializer) && node.initializer.expression
          ? visibleLiterals(node.initializer.expression)
          : []
      for (const literal of values) {
        refuse(
          literal.node,
          'hard-coded-string',
          `hard-codes "${literal.text.trim()}" in ${attributeName(node)}: words come from useLocalization()`
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return refusals
}

/** A property or attribute that writes markup from a string. */
function isHtmlSink(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return HTML_SINKS.has(node.name.text)
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return HTML_SINKS.has(node.argumentExpression.text)
  }
  if (ts.isJsxAttribute(node)) {
    return HTML_SINKS.has(attributeName(node))
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    return ts.isIdentifier(node.name) && HTML_SINKS.has(node.name.text)
  }
  return false
}

function attributeName(node: ts.JsxAttribute): string {
  return node.name.getText()
}

/** `x.session.signOut`, `client.signOut` and `useTula().session.signOut`, called or passed on. */
function isClientSignOut(node: ts.Node): boolean {
  const named = (name: string) => name === 'signOut'
  let receiver: ts.Expression | undefined
  if (ts.isPropertyAccessExpression(node) && named(node.name.text)) {
    receiver = node.expression
  } else if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    named(node.argumentExpression.text)
  ) {
    receiver = node.expression
  }
  if (!receiver) {
    return false
  }
  // The receiver's last name: `…​.session`, `…​.client`, or the client a hook returns.
  const text = receiver.getText().replace(/\s+/g, '')
  return /(?:^|[.)\]])(?:session|client)$/.test(text) || /^useTula\(\)$/.test(text)
}

/**
 * `const { signOut } = client.session` (or `useTula()`): the same call, written by destructuring.
 * The check reads text, so a client held under another name (`const s = client.session`) is
 * not seen: the rules file says so.
 */
function isDestructuredClientSignOut(node: ts.Node): boolean {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isObjectBindingPattern(node.name) ||
    !node.initializer
  ) {
    return false
  }
  const takesSignOut = node.name.elements.some(
    (element) => (element.propertyName ?? element.name).getText() === 'signOut'
  )
  const text = node.initializer.getText().replace(/\s+/g, '')
  return (
    takesSignOut && (/(?:^|[.)\]])(?:session|client)$/.test(text) || /^useTula\(\)$/.test(text))
  )
}

/** Whether an identifier is a reference to a variable, not a name being declared or a property. */
function isGlobalReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false
  }
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) {
    return false
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent)) &&
    parent.name === node
  ) {
    return false
  }
  if (ts.isJsxAttribute(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent)) {
    return false
  }
  return true
}

/**
 * Whether the code runs after render: inside a function handed to an effect hook, inside an
 * event handler (`onClick={() => …}`), or inside a function named `handle…` or `on…`.
 */
function inLaterWork(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) {
      continue
    }
    const holder = current.parent
    if (
      ts.isCallExpression(holder) &&
      ts.isIdentifier(holder.expression) &&
      HOOKS_OF_EFFECTS.has(holder.expression.text)
    ) {
      return true
    }
    if (ts.isJsxExpression(holder) && ts.isJsxAttribute(holder.parent)) {
      if (/^on[A-Z]/.test(attributeName(holder.parent))) {
        return true
      }
    }
    if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
      if (/^(?:handle|on)[A-Z]/.test(holder.name.text)) {
        return true
      }
    }
    if (
      ts.isFunctionDeclaration(current) &&
      current.name &&
      /^(?:handle|on)[A-Z]/.test(current.name.text)
    ) {
      return true
    }
  }
  return false
}

/** A piece of fixed text found in an expression, and the node to point at. */
interface Literal {
  node: ts.Node
  text: string
}

/**
 * The fixed text in an expression that ends up on the page: the branches of a condition, the
 * operands of `??`, `||` and `&&`, the arguments of a call, a template's words. Not a literal
 * that is only compared, and not nested JSX or a nested function, which are judged where they
 * are drawn.
 */
function visibleLiterals(expression: ts.Expression): Literal[] {
  const found: Literal[] = []
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      if (hasLetters(node.text)) {
        found.push({ node, text: node.text })
      }
      return
    }
    if (ts.isTemplateExpression(node)) {
      const words = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
        ''
      )
      if (hasLetters(words)) {
        found.push({ node, text: words })
      }
      for (const span of node.templateSpans) {
        walk(span.expression)
      }
      return
    }
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
      return
    }
    if (ts.isConditionalExpression(node)) {
      // The condition is a test, not output.
      walk(node.whenTrue)
      walk(node.whenFalse)
      return
    }
    if (ts.isCallExpression(node)) {
      // What a call is given may be what it prints (`formatText('Hello {name}', …)`).
      for (const argument of node.arguments) {
        walk(argument)
      }
      return
    }
    if (ts.isFunctionLike(node) || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(expression)
  return found
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
])
