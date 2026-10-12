import { describe, expect, test } from 'bun:test'
import type { SchemaNode } from '../openapi-types'
import { fixture, object, ref } from './fixture'
import { renderKotlinErrorCodes, renderKotlinOperations, renderKotlinSchemas } from './kotlin'
import { buildModel, type NativeDeclaration, type NativeStruct } from './model'
import { renderSwiftErrorCodes, renderSwiftOperations, renderSwiftSchemas } from './swift'

// What a document could hold that the real one does not: names that are also members of every
// JavaScript object, names the generator writes itself, names that would not compile, and
// text that tries to leave the comment it is written in.

function declarations(schemas: Record<string, SchemaNode>): Record<string, NativeDeclaration> {
  return Object.fromEntries(
    buildModel(fixture(schemas), []).declarations.map((declaration) => [
      declaration.name,
      declaration,
    ])
  )
}

function propertiesOf(schema: SchemaNode, others: Record<string, SchemaNode> = {}) {
  const answer = declarations({ Answer: schema, ...others }).Answer as NativeStruct
  return Object.fromEntries(answer.properties.map((property) => [property.wireName, property]))
}

/** A union of two inline objects told apart by `discriminator`, with the tags given. */
function unionBy(discriminator: string, tags: [string, string] = ['one', 'two']): SchemaNode {
  return {
    oneOf: tags.map((tag) =>
      object({ [discriminator]: { type: 'string', const: tag } }, [discriminator])
    ),
  }
}

const swiftOf = (schemas: Record<string, SchemaNode>) =>
  renderSwiftSchemas(buildModel(fixture(schemas), []))
const kotlinOf = (schemas: Record<string, SchemaNode>) =>
  renderKotlinSchemas(buildModel(fixture(schemas), []))

describe('a name from the document is never looked up on a plain object', () => {
  // A property written as a literal `__proto__:` would set the fixture's prototype instead of
  // adding a key; parsed JSON, like the real document, has it as a key of its own.
  const withProto = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"integer"}},"required":["__proto__"]}'
  ) as SchemaNode

  test('an object may have a property called __proto__, constructor or toString', () => {
    const properties = propertiesOf(withProto)
    expect(Object.keys(properties)).toEqual(['__proto__', 'a'])
    expect(Object.getOwnPropertyDescriptor(properties, '__proto__')?.value).toMatchObject({
      wireName: '__proto__',
      type: { kind: 'string' },
      required: true,
    })
    expect(
      Object.keys(
        propertiesOf(object({ constructor: { type: 'string' }, toString: { type: 'boolean' } }))
      )
    ).toEqual(['constructor', 'toString'])
  })

  test('allOf keeps a property called constructor or toString, with no error of its own making', () => {
    const properties = propertiesOf({
      allOf: [
        object({ constructor: { type: 'string' } }, ['constructor']),
        object({ toString: { type: 'integer' }, valueOf: { type: 'boolean' } }),
      ],
    })
    expect(Object.keys(properties)).toEqual(['constructor', 'toString', 'valueOf'])
    expect(Object.getOwnPropertyDescriptor(properties, 'constructor')?.value).toMatchObject({
      type: { kind: 'string' },
      required: true,
    })
  })

  test('allOf keeps a property called __proto__: it does not vanish', () => {
    const properties = propertiesOf({ allOf: [withProto, object({ b: { type: 'string' } })] })
    expect(Object.keys(properties)).toEqual(['__proto__', 'a', 'b'])
    expect(Object.getOwnPropertyDescriptor(properties, '__proto__')?.value).toMatchObject({
      type: { kind: 'string' },
      required: true,
    })
  })

  test('allOf still refuses a property two members declare differently, also one called constructor', () => {
    expect(() =>
      propertiesOf({
        allOf: [
          object({ constructor: { type: 'string' } }),
          object({ constructor: { type: 'integer' } }),
        ],
      })
    ).toThrow('unsupported "allOf": "constructor" is declared in two different ways')
  })

  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'a type called %s is no type',
    (type) => {
      expect(() => propertiesOf(object({ a: { type } as SchemaNode }))).toThrow(
        `unsupported JSON Schema type ${JSON.stringify(type)}`
      )
    }
  )

  test.each(['constructor', 'toString', '__proto__'])(
    'a list of types with %s in it is not a list of scalars',
    (type) => {
      expect(() => propertiesOf(object({ a: { type: ['string', type] } as SchemaNode }))).toThrow(
        'its alternatives have no discriminator'
      )
    }
  )

  test.each(['constructor', 'toString', '__proto__'])(
    'a reference to a component called %s, which the document does not have, is not followed',
    (name) => {
      expect(() =>
        propertiesOf({ allOf: [ref(name), object({ a: { type: 'string' } })] })
      ).toThrow()
      expect(() =>
        propertiesOf(object({ a: { anyOf: [ref(name), ref('Other')] } }), { Other: object({}) })
      ).toThrow()
    }
  )
})

describe('a name the generator writes itself cannot be taken by the document', () => {
  test.each([
    'TulaTheme',
    'TulaThemeScheme',
    'TulaThemeToken',
    'TulaThemeDefaults',
    'TulaOperation',
    'TulaOperations',
    'TulaErrorDefinition',
    'TulaErrorDefinitions',
    'TulaJSONValue',
    'TulaCodingKey',
    'TulaJson',
    'ErrorCodeSerializer',
    // The same names once they are put in PascalCase.
    'tula_json',
    'tula_operations',
    'error_code',
  ])('a component called %s stops the generation', (name) => {
    expect(() => declarations({ Answer: object({ a: ref(name) }), [name]: object({}) })).toThrow(
      /^two declarations would be named "(Tula\w+|ErrorCode(Serializer)?)"$/
    )
  })

  test('nor by a declaration made for a property', () => {
    // `Tula` + `Theme`: the object written inline under the key `theme`.
    expect(() =>
      declarations({ Answer: object({ a: ref('Tula') }), Tula: object({ theme: object({}) }) })
    ).toThrow('two declarations would be named "TulaTheme"')
  })

  test.each([
    ['an open enum', { type: 'string', enum: ['a', 'b'] }, true],
    ['a closed enum', { type: 'string', enum: ['a', 'b'] }, false],
    ['a union', unionBy('kind'), true],
  ] as const)('a component called like the serializer of %s', (_name, schema, inAnswer) => {
    const holder = object({ foo: ref('Foo'), serializer: ref('FooSerializer') })
    const schemas = {
      Foo: schema as SchemaNode,
      FooSerializer: object({}),
      ...(inAnswer ? { Answer: holder } : { Answer: object({}), Request: holder }),
    }
    expect(() => declarations(schemas)).toThrow('two declarations would be named "FooSerializer"')
  })

  test('a struct beside one called like its serializer would be is fine: a struct has none', () => {
    expect(
      Object.keys(
        declarations({
          Answer: object({ foo: ref('Foo'), serializer: ref('FooSerializer') }),
          Foo: object({}),
          FooSerializer: object({}),
        })
      )
    ).toEqual(['Answer', 'Foo', 'FooSerializer'])
  })
})

describe('a member whose name would not compile stops the generation', () => {
  test('Swift: a property called hashValue, which every Hashable type already has', () => {
    const schemas = { Answer: object({ hashValue: { type: 'string' } }) }
    expect(() => swiftOf(schemas)).toThrow('Answer: a property cannot be named hashValue')
    expect(() => swiftOf({ Answer: object({ hash_value: { type: 'string' } }) })).toThrow(
      'Answer: a property cannot be named hashValue'
    )
    // Kotlin has no such member: the same document is fine there.
    expect(kotlinOf(schemas)).toContain('    val hashValue: String? = null,')
  })

  test('Swift: a union whose discriminator is also the name of one of its cases', () => {
    expect(() => swiftOf({ Answer: object({ s: ref('Step') }), Step: unionBy('one') })).toThrow(
      'Step: its discriminator and a case would both be named one'
    )
  })

  test.each(['raw', 'Raw'])('a union told apart by a property called %s', (discriminator) => {
    const schemas = { Answer: object({ s: ref('Step') }), Step: unionBy(discriminator) }
    expect(() => swiftOf(schemas)).toThrow('Step: a discriminator cannot be named raw')
    expect(() => kotlinOf(schemas)).toThrow('Step: a discriminator cannot be named raw')
  })

  test('Kotlin: a union told apart by a property called value', () => {
    const schemas = { Answer: object({ s: ref('Step') }), Step: unionBy('value') }
    expect(() => kotlinOf(schemas)).toThrow('Step: a discriminator cannot be named value')
    // In Swift nothing else of a union is called `value` where the property is declared.
    expect(swiftOf(schemas)).toContain('    public var value: String {')
  })

  test('Kotlin: a variant whose nested class hides the type it holds', () => {
    const schemas = {
      Answer: object({ s: ref('Step') }),
      Step: { oneOf: [ref('Complete'), ref('Waiting')] },
      Complete: object({ status: { const: 'complete' } }, ['status']),
      Waiting: object({ status: { const: 'waiting' } }, ['status']),
    }
    expect(() => kotlinOf(schemas)).toThrow(
      'Step: the variant Complete would hide the type Complete'
    )
    // Swift's cases are in camelCase and hide no type.
    expect(swiftOf(schemas)).toContain('    case complete(Complete)')
  })

  test('Kotlin: a variant whose nested class hides the union itself', () => {
    const schemas = { Answer: object({ s: ref('Step') }), Step: unionBy('kind', ['step', 'x']) }
    expect(() => kotlinOf(schemas)).toThrow('Step: the variant Step would hide the type Step')
  })

  test.each(['string', 'json_object', 'list'])(
    'Kotlin: a variant whose nested class hides %s, which the class itself names',
    (tag) => {
      const schemas = { Answer: object({ s: ref('Step') }), Step: unionBy('kind', [tag, 'x']) }
      expect(() => kotlinOf(schemas)).toThrow(/^Step: the variant \w+ would hide the type \w+$/)
    }
  )

  test('Kotlin: an enum member whose object would hide String or the enum itself', () => {
    expect(() =>
      kotlinOf({ Answer: object({ c: ref('Colour') }), Colour: { enum: ['string', 'red'] } })
    ).toThrow('Colour: the member String would hide the type String')
    expect(() =>
      kotlinOf({ Answer: object({ c: ref('Colour') }), Colour: { enum: ['colour', 'red'] } })
    ).toThrow('Colour: the member Colour would hide the type Colour')
  })
})

describe('text of the document cannot leave the comment it is written in', () => {
  // Written with their code points: a literal one would end this line for some tools.
  const LINE_SEPARATOR = String.fromCharCode(0x2028)
  const LINE_BREAK = new RegExp(`\\r\\n|[\\n\\r${LINE_SEPARATOR}${String.fromCharCode(0x2029)}]`)
  const hostile = [
    ['a comment end, a line break and an import', 'x*/\nimport Evil\n/*'],
    ['a line break alone', 'kind\nimport Evil'],
    ['a carriage return', 'kind\rimport Evil'],
    ['a line separator', `kind${LINE_SEPARATOR}import Evil`],
    ['a backtick and a line break', 'kind`\nimport Evil'],
  ] as const

  /** Whether a line is a comment and nothing else. */
  const isComment = (line: string) => /^\s*(\/\/\/|\/\/|\/\*\*.*\*\/$)/.test(line)

  function expectContained(text: string) {
    const lines = text.split(LINE_BREAK)
    // Nothing that reads as a statement: the name reaches code only inside a string literal,
    // where the line break is written as an escape.
    expect(lines.filter((line) => /^\s*import\s+Evil/.test(line))).toEqual([])
    for (const line of lines.filter((one) => one.includes('Evil'))) {
      const inLiteral = /"(?:[^"\\]|\\.)*Evil(?:[^"\\]|\\.)*"/.test(line)
      const inIdentifier = /\b\w*Evil\w*\b/.test(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'))
      expect({ line, contained: isComment(line) || inLiteral || inIdentifier }).toEqual({
        line,
        contained: true,
      })
    }
    // A line comment ends with its line, whatever it holds (`/v1/client/*` among it).
    const isLineComment = (line: string) => /^\s*\/\//.test(line)
    for (const line of lines.filter((one) => isComment(one) && !isLineComment(one))) {
      // A block comment is opened once, at the start, and closed once, at the end.
      const body = line
        .trim()
        .replace(/^\/\*\*/, '')
        .replace(/\*\/$/, '')
      expect({ line, clean: !body.includes('*/') && !body.includes('/*') }).toEqual({
        line,
        clean: true,
      })
    }
    // Outside a string literal, `*/` is only ever the end of a comment line.
    for (const line of lines.filter((one) => !isLineComment(one))) {
      const code = line.replace(/"(?:[^"\\]|\\.)*"/g, '""')
      if (code.includes('*/')) {
        expect({
          line,
          closer: /^\s*\/\*\*.*\*\/$/.test(code) && code.indexOf('*/') === code.length - 2,
        }).toEqual({
          line,
          closer: true,
        })
      }
    }
  }

  test.each(hostile)(
    'a discriminator that holds %s: open and closed, both languages',
    (_n, name) => {
      const open = { Answer: object({ s: ref('Step') }), Step: unionBy(name) }
      const closed = {
        Answer: object({}),
        Request: object({ s: ref('Step') }),
        Step: unionBy(name),
      }
      for (const schemas of [open, closed]) {
        expectContained(swiftOf(schemas))
        expectContained(kotlinOf(schemas))
      }
    }
  )

  test('the check itself: an import on a line of its own is found', () => {
    expect(() => expectContained('/// x\nimport Evil\n')).toThrow()
    expect(() => expectContained('/** x */ import Evil /* */\n')).toThrow()
    expect(() => expectContained('    /** a */ b */\n')).toThrow()
  })

  test.each(hostile)('an error code that holds %s', (_n, code) => {
    const definitions = { [code]: { status: 400, message: `no\n*/ import Evil` } }
    expectContained(renderSwiftErrorCodes(definitions))
    expectContained(renderKotlinErrorCodes(definitions))
  })

  test.each(hostile)('an operation whose summary, path and id hold %s', (_n, text) => {
    const document = fixture({ Answer: object({}) })
    ;(document.paths as Record<string, unknown>)[`/v1/client/${text}`] = {
      get: { operationId: `get ${text}`, summary: text, responses: { 204: {} } },
    }
    const model = buildModel(document, [])
    expectContained(renderSwiftOperations(model))
    expectContained(renderKotlinOperations(model))
  })

  test.each(hostile)('a format, an enum member and a property name that hold %s', (_n, text) => {
    const schemas = {
      Answer: object({
        [text]: { type: 'string', format: text, description: text },
        c: ref('Colour'),
        k: { type: 'string', const: text },
      }),
      Colour: { type: 'string', enum: [text, 'red'], description: text } as SchemaNode,
    }
    expectContained(swiftOf(schemas))
    expectContained(kotlinOf(schemas))
  })
})

describe('the order of the operations', () => {
  test('is by code point, whatever the locale of the machine', () => {
    const document = fixture({ Answer: object({}) })
    const paths = document.paths as Record<string, unknown>
    for (const id of ['b', 'Z', 'a', 'B', '_x', 'a1', 'aB', 'ab']) {
      paths[`/v1/client/order/${id}`] = { get: { operationId: id, responses: { 204: {} } } }
    }
    const ids = buildModel(document, []).operations.map((operation) => operation.id)
    // A locale-aware comparison puts "a" before "B" and "ab" before "aB"; a code point one
    // puts every capital first, on every machine.
    expect(ids).toEqual(['B', 'Z', '_x', 'a', 'a1', 'aB', 'ab', 'askNothing', 'b', 'doThing'])
  })
})
