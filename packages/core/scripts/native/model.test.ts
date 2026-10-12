import { describe, expect, test } from 'bun:test'
import type { SchemaNode } from '../openapi-types'
import { fixture, jsonBody, object, ref } from './fixture'
import { buildModel, type NativeDeclaration, type NativeStruct } from './model'

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

describe('which schemas are generated', () => {
  test('only what the client operations reach, in order of name', () => {
    const model = buildModel(
      fixture({
        Request: object({ nested: ref('Nested') }),
        Nested: object({ a: { type: 'string' } }),
        Answer: object({}),
        Failure: object({ detail: { type: 'string' } }),
        AdminOnly: object({ secret: { type: 'string' } }),
        Unreachable: object({}),
      }),
      []
    )
    expect(model.declarations.map((declaration) => declaration.name)).toEqual([
      'Answer',
      'Failure',
      'Nested',
      'Request',
    ])
  })

  test('the operations, in order of id, with their types', () => {
    const model = buildModel(fixture({ Request: object({}), Answer: object({}) }), [])
    expect(model.operations).toEqual([
      {
        id: 'askNothing',
        method: 'DELETE',
        path: '/v1/client/nothing',
        summary: 'askNothing',
        session: false,
      },
      {
        id: 'doThing',
        method: 'POST',
        path: '/v1/client/things/{thingId}',
        summary: 'Do the thing',
        session: true,
        body: { kind: 'named', name: 'Request' },
        response: { kind: 'named', name: 'Answer' },
      },
    ])
  })

  test('a body or a response declared inline has no name, and fails', () => {
    const document = fixture({ Answer: object({}) })
    const operation = document.paths['/v1/client/things/{thingId}']?.post
    if (!operation) {
      throw new Error('the fixture has the operation')
    }
    operation.responses[200] = jsonBody(object({ a: { type: 'string' } }))
    expect(() => buildModel(document, [])).toThrow('inline')
  })
})

describe('objects', () => {
  test('required, optional and nullable are three different things', () => {
    const properties = propertiesOf(
      object(
        {
          always: { type: 'string' },
          sometimes: { type: 'string' },
          alwaysOrNull: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          sometimesOrNull: { type: ['integer', 'null'] },
        },
        ['always', 'alwaysOrNull']
      )
    )
    expect(properties.always).toEqual({
      wireName: 'always',
      type: { kind: 'string' },
      required: true,
      nullable: false,
    })
    expect(properties.sometimes).toMatchObject({ required: false, nullable: false })
    expect(properties.alwaysOrNull).toMatchObject({
      type: { kind: 'string' },
      required: true,
      nullable: true,
    })
    expect(properties.sometimesOrNull).toMatchObject({
      type: { kind: 'integer' },
      required: false,
      nullable: true,
    })
  })

  test('scalars, and a format that is documentation and never a type', () => {
    const properties = propertiesOf(
      object({
        text: { type: 'string' },
        whole: { type: 'integer' },
        fraction: { type: 'number' },
        flag: { type: 'boolean' },
        at: { type: 'string', format: 'date-time', description: 'When it happened.' },
        // A format nobody has heard of changes nothing.
        odd: { type: 'string', format: 'x-klingon-date' },
        anything: {},
        annotated: { description: 'Anything at all.' },
        nothing: { type: 'null' },
      })
    )
    expect(properties.text?.type).toEqual({ kind: 'string' })
    expect(properties.whole?.type).toEqual({ kind: 'integer' })
    expect(properties.fraction?.type).toEqual({ kind: 'number' })
    expect(properties.flag?.type).toEqual({ kind: 'boolean' })
    expect(properties.at).toMatchObject({
      type: { kind: 'string' },
      format: 'date-time',
      description: 'When it happened.',
    })
    expect(properties.odd).toMatchObject({ type: { kind: 'string' }, format: 'x-klingon-date' })
    expect(properties.anything?.type).toEqual({ kind: 'json' })
    expect(properties.annotated?.type).toEqual({ kind: 'json' })
    expect(properties.nothing).toMatchObject({ type: { kind: 'json' }, nullable: true })
  })

  test('a const is a value of its type with the one value it has today', () => {
    const properties = propertiesOf(
      object({
        kind: { type: 'string', const: 'public-key' },
        always: { const: true },
        count: { const: 3 },
        ratio: { const: 0.5 },
        none: { const: null },
      })
    )
    expect(properties.kind).toMatchObject({ type: { kind: 'string' }, constant: 'public-key' })
    expect(properties.always).toMatchObject({ type: { kind: 'boolean' }, constant: true })
    // A number that never changes is still only a number: no default is written for it.
    expect(properties.count).toEqual({
      wireName: 'count',
      type: { kind: 'integer' },
      required: false,
      nullable: false,
    })
    expect(properties.ratio?.type).toEqual({ kind: 'number' })
    expect(properties.none).toMatchObject({ type: { kind: 'json' }, nullable: true })
  })

  test('nested arrays, an array with no items, and a nullable item', () => {
    const properties = propertiesOf(
      object({
        grid: { type: 'array', items: { type: 'array', items: ref('Cell') } },
        loose: { type: 'array' },
        holes: { type: 'array', items: { type: ['string', 'null'] } },
      }),
      { Cell: object({ x: { type: 'integer' } }) }
    )
    expect(properties.grid?.type).toEqual({
      kind: 'array',
      items: { kind: 'array', items: { kind: 'named', name: 'Cell' } },
    })
    expect(properties.loose?.type).toEqual({ kind: 'array', items: { kind: 'json' } })
    expect(properties.holes?.type).toEqual({
      kind: 'array',
      items: { kind: 'nullable', of: { kind: 'string' } },
    })
  })

  test('maps: typed values, open values, and a map of objects', () => {
    const found = declarations({
      Answer: object({
        counts: { type: 'object', additionalProperties: { type: 'integer' } },
        open: { type: 'object', additionalProperties: true },
        loose: { type: 'object', additionalProperties: {} },
        byName: {
          type: 'object',
          additionalProperties: object({ id: { type: 'string' } }, ['id']),
        },
      }),
      Params: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      Request: object({ params: ref('Params') }),
    })
    const properties = Object.fromEntries(
      (found.Answer as NativeStruct).properties.map((property) => [property.wireName, property])
    )
    expect(properties.counts?.type).toEqual({ kind: 'map', values: { kind: 'integer' } })
    expect(properties.open?.type).toEqual({ kind: 'map', values: { kind: 'json' } })
    expect(properties.loose?.type).toEqual({ kind: 'map', values: { kind: 'json' } })
    expect(properties.byName?.type).toEqual({
      kind: 'map',
      values: { kind: 'named', name: 'AnswerByNameValue' },
    })
    expect(found.AnswerByNameValue).toMatchObject({ kind: 'struct' })
    // A map is not a declaration of its own kind: the component is a name for it. A value
    // that is one of several scalars is carried as a JSON value.
    expect(found.Params).toEqual({
      kind: 'alias',
      name: 'Params',
      type: { kind: 'map', values: { kind: 'json' } },
    })
  })

  test('an inline object, and an inline item, get the name of where they are', () => {
    const found = declarations({
      Answer: object({
        owner: object({ id: { type: 'string' } }),
        entries: { type: 'array', items: object({ key: { type: 'string' } }) },
        nothing: { type: 'object' },
      }),
    })
    expect(Object.keys(found).sort()).toEqual([
      'Answer',
      'AnswerEntriesItem',
      'AnswerNothing',
      'AnswerOwner',
    ])
    expect((found.AnswerNothing as NativeStruct).properties).toEqual([])
  })

  test('an open object keeps its named properties; extra keys are not modelled', () => {
    const properties = propertiesOf({
      ...object({ id: { type: 'string' } }, ['id']),
      additionalProperties: {},
    })
    expect(Object.keys(properties)).toEqual(['id'])
  })

  test('named properties beside typed extra ones have no native type, and fail', () => {
    expect(() =>
      declarations({
        Answer: { ...object({ id: { type: 'string' } }), additionalProperties: { type: 'string' } },
      })
    ).toThrow('unsupported object at "Answer"')
  })

  test('a description is kept on a declaration', () => {
    const found = declarations({
      Answer: { ...object({}), description: 'What came back.' },
      Kind: { type: 'string', enum: ['a'], description: 'A kind.' },
      Request: object({ kind: ref('Kind'), alias: ref('Words') }),
      Words: { type: 'array', items: { type: 'string' }, description: 'Some words.' },
    })
    expect(found.Answer?.description).toBe('What came back.')
    expect(found.Kind?.description).toBe('A kind.')
    expect(found.Words).toEqual({
      kind: 'alias',
      name: 'Words',
      description: 'Some words.',
      type: { kind: 'array', items: { kind: 'string' } },
    })
  })
})

describe('allOf', () => {
  test('objects are put together: every property, every required key', () => {
    const found = declarations({
      Base: object({ id: { type: 'string' }, note: { type: 'string' } }, ['id']),
      Answer: {
        description: 'Both halves.',
        allOf: [
          ref('Base'),
          object({ extra: { type: 'integer' }, id: { type: 'string' } }, ['extra']),
        ],
      },
    })
    expect(found.Answer).toEqual({
      kind: 'struct',
      name: 'Answer',
      description: 'Both halves.',
      properties: [
        { wireName: 'id', type: { kind: 'string' }, required: true, nullable: false },
        { wireName: 'note', type: { kind: 'string' }, required: false, nullable: false },
        { wireName: 'extra', type: { kind: 'integer' }, required: true, nullable: false },
      ],
    })
  })

  test('an allOf beside properties of its own, and one inside another', () => {
    const found = declarations({
      Base: object({ id: { type: 'string' } }, ['id']),
      Middle: { allOf: [ref('Base'), object({ m: { type: 'boolean' } })] },
      Answer: { allOf: [ref('Middle')], type: 'object', properties: { own: { type: 'string' } } },
    })
    expect((found.Answer as NativeStruct).properties.map((property) => property.wireName)).toEqual([
      'id',
      'm',
      'own',
    ])
  })

  test.each([
    ['a member that is not an object', { allOf: [{ type: 'string' }] }, 'plain object'],
    [
      'a member that is a map',
      { allOf: [{ type: 'object', additionalProperties: { type: 'string' } }] },
      'plain object',
    ],
    [
      'a property declared in two ways',
      { allOf: [object({ a: { type: 'string' } }), object({ a: { type: 'integer' } })] },
      '"a" is declared in two different ways',
    ],
  ] as [string, SchemaNode, string][])('%s fails the generation', (_name, schema, message) => {
    expect(() => declarations({ Answer: schema })).toThrow(message)
  })
})

describe('enums: open where a response can carry one, closed where only a request does', () => {
  const schemas = {
    Shared: { type: 'string', enum: ['a', 'b'] },
    Asked: { type: 'string', enum: ['x', 'y'] },
    Told: { type: 'string', enum: ['p'] },
    Request: object({ shared: ref('Shared'), asked: ref('Asked'), inline: { enum: ['one'] } }),
    Answer: object({
      shared: ref('Shared'),
      told: ref('Told'),
      inline: { type: 'string', enum: ['up', 'down'] },
    }),
    Failure: object({ why: { type: 'string', enum: ['because'] } }),
  } satisfies Record<string, SchemaNode>

  test.each([
    ['Shared', true, 'a response and a request both carry it'],
    ['Told', true, 'only a response carries it'],
    ['AnswerInline', true, 'declared inside a response'],
    ['FailureWhy', true, 'an error answer is a response too'],
    ['Asked', false, 'only a request carries it'],
    ['RequestInline', false, 'declared inside a request'],
  ])('%s: open is %p (%s)', (name, open) => {
    expect(declarations(schemas)[name]).toMatchObject({ kind: 'enum', open })
  })

  test('the members keep the order of the document', () => {
    expect(declarations(schemas).AnswerInline).toMatchObject({ values: ['up', 'down'] })
  })

  test('a null among the members makes the value nullable, not a member', () => {
    const properties = propertiesOf(
      object({
        level: { enum: ['low', 'high', null] },
        typed: { type: ['string', 'null'], enum: ['on', 'off'] },
      })
    )
    expect(properties.level).toMatchObject({
      type: { kind: 'named', name: 'AnswerLevel' },
      nullable: true,
    })
    expect(properties.typed).toMatchObject({
      type: { kind: 'named', name: 'AnswerTyped' },
      nullable: true,
    })
  })

  test('an enum that is not of strings is a value of its type', () => {
    const properties = propertiesOf(
      object({
        never: { type: 'boolean', enum: [false] },
        steps: { enum: [1, 2, 3] },
        ratios: { enum: [0.5, 1] },
        nullableFlag: { enum: [true, null] },
      })
    )
    expect(properties.never?.type).toEqual({ kind: 'boolean' })
    expect(properties.steps?.type).toEqual({ kind: 'integer' })
    expect(properties.ratios?.type).toEqual({ kind: 'number' })
    expect(properties.nullableFlag).toMatchObject({ type: { kind: 'boolean' }, nullable: true })
  })

  test('an enum of mixed types fails the generation', () => {
    expect(() => declarations({ Answer: object({ odd: { enum: ['a', 1] } }) })).toThrow(
      'unsupported enum at "AnswerOdd"'
    )
  })
})

describe('unions told apart by a const', () => {
  const step: SchemaNode = {
    description: 'What to do next.',
    oneOf: [
      object({ status: { type: 'string', const: 'needs_password' } }, ['status']),
      object(
        {
          status: { type: 'string', const: 'complete' },
          userId: { type: 'string' },
          // A second const, the same in no other variant, is not what tells them apart.
          version: { type: 'string', const: 'v1' },
        },
        ['status', 'userId']
      ),
    ],
  }

  test('the union, its variants in document order, and a declaration per variant', () => {
    const found = declarations({ Answer: object({ step: ref('Step') }, ['step']), Step: step })
    expect(found.Step).toEqual({
      kind: 'union',
      name: 'Step',
      description: 'What to do next.',
      discriminator: 'status',
      open: true,
      variants: [
        { tag: 'needs_password', type: 'StepNeedsPassword' },
        { tag: 'complete', type: 'StepComplete' },
      ],
    })
    // The tag stays a property of the variant: a const like any other.
    expect((found.StepComplete as NativeStruct).properties[0]).toEqual({
      wireName: 'status',
      type: { kind: 'string' },
      required: true,
      nullable: false,
      constant: 'complete',
    })
  })

  test('a union only a request carries is closed', () => {
    const found = declarations({ Answer: object({}), Request: step })
    expect(found.Request).toMatchObject({ kind: 'union', open: false })
  })

  test('a variant that is a component keeps its own name', () => {
    const found = declarations({
      Cat: object({ kind: { const: 'cat' }, lives: { type: 'integer' } }, ['kind']),
      Dog: object({ kind: { const: 'dog' } }, ['kind']),
      Answer: { anyOf: [ref('Cat'), ref('Dog')] },
    })
    expect(found.Answer).toMatchObject({
      kind: 'union',
      discriminator: 'kind',
      variants: [
        { tag: 'cat', type: 'Cat' },
        { tag: 'dog', type: 'Dog' },
      ],
    })
  })

  test('a nullable union is the union, nullable', () => {
    const properties = propertiesOf(
      object({
        pet: {
          anyOf: [
            object({ kind: { const: 'cat' } }, ['kind']),
            object({ kind: { const: 'dog' } }, ['kind']),
            { type: 'null' },
          ],
        },
      })
    )
    expect(properties.pet).toMatchObject({
      type: { kind: 'named', name: 'AnswerPet' },
      nullable: true,
    })
  })

  test.each([
    [
      'two variants with the same tag',
      [object({ kind: { const: 'a' } }, ['kind']), object({ kind: { const: 'a' } }, ['kind'])],
    ],
    [
      'a tag that is not required',
      [object({ kind: { const: 'a' } }, ['kind']), object({ kind: { const: 'b' } })],
    ],
    [
      'a variant with no const',
      [object({ kind: { const: 'a' } }, ['kind']), object({ kind: { type: 'string' } }, ['kind'])],
    ],
    ['objects and a scalar', [object({ kind: { const: 'a' } }, ['kind']), { type: 'string' }]],
    ['an object type beside a scalar', [{ type: 'object' }, { type: 'string' }]],
    ['scalars where one is an enum', [{ type: 'string', enum: ['a'] }, { type: 'integer' }]],
  ] as [string, SchemaNode[]][])(
    '%s has nothing to choose a variant by, and fails',
    (_name, oneOf) => {
      expect(() => declarations({ Answer: object({ value: { oneOf } }) })).toThrow(
        'unsupported union at "AnswerValue"'
      )
    }
  )

  test('a type list of an object and a scalar fails the same way', () => {
    expect(() =>
      declarations({ Answer: object({ value: { type: ['object', 'string'] } }) })
    ).toThrow('unsupported union at "AnswerValue"')
  })

  test('one of several scalars is a JSON value', () => {
    const properties = propertiesOf(
      object({
        listed: { type: ['string', 'number', 'boolean'] },
        either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        orNull: { type: ['string', 'integer', 'null'] },
      })
    )
    expect(properties.listed?.type).toEqual({ kind: 'json' })
    expect(properties.either?.type).toEqual({ kind: 'json' })
    expect(properties.orNull).toMatchObject({ type: { kind: 'json' }, nullable: true })
  })
})

describe('what is not mapped fails the generation instead of being guessed at', () => {
  test.each([
    ['not', { not: { type: 'string' } }],
    ['prefixItems', { type: 'array', prefixItems: [{ type: 'string' }] }],
    ['patternProperties', { type: 'object', patternProperties: {} }],
    ['if', { if: {} }],
    ['else', { else: {} }],
  ] as [string, SchemaNode][])('the keyword %s', (keyword, schema) => {
    expect(() => declarations({ Answer: object({ value: schema }) })).toThrow(
      `unsupported JSON Schema keyword "${keyword}"`
    )
  })

  test('a type nobody defined', () => {
    expect(() => declarations({ Answer: object({ value: { type: 'bigint' } }) })).toThrow(
      'unsupported JSON Schema type "bigint"'
    )
  })

  test('two declarations that would get one name', () => {
    expect(() =>
      declarations({
        Answer: object({ owner: object({ a: { type: 'string' } }), other: ref('AnswerOwner') }),
        AnswerOwner: object({}),
      })
    ).toThrow('two declarations would be named "AnswerOwner"')
  })

  test('a reference that leads nowhere, and one that leads in a circle', () => {
    expect(() => declarations({ Answer: { anyOf: [ref('Missing'), ref('Missing')] } })).toThrow(
      'not defined'
    )
    expect(() =>
      declarations({
        Answer: object({ value: { oneOf: [ref('Loop'), ref('Loop')] } }),
        Loop: ref('Loop'),
      })
    ).toThrow('cannot be resolved')
  })

  test('a name a standard type has is given the prefix, wherever it is referred to', () => {
    const found = declarations({
      Error: object({ detail: { type: 'string' } }),
      Answer: object({ error: ref('Error') }),
    })
    expect(found.TulaError).toMatchObject({ kind: 'struct', name: 'TulaError' })
    expect((found.Answer as NativeStruct).properties[0]?.type).toEqual({
      kind: 'named',
      name: 'TulaError',
    })
  })
})

describe('the error code', () => {
  const schemas = {
    ErrorCode: { type: 'string', enum: ['a.b', 'c.d'] },
    Answer: object({ code: ref('ErrorCode') }),
  } satisfies Record<string, SchemaNode>

  test('is not declared from the document: the contract writes it', () => {
    const model = buildModel(fixture(schemas), ['c.d', 'a.b'])
    expect(model.declarations.map((declaration) => declaration.name)).toEqual(['Answer'])
    expect((model.declarations[0] as NativeStruct).properties[0]?.type).toEqual({
      kind: 'named',
      name: 'ErrorCode',
    })
  })

  test.each([
    ['a code the document does not have', ['a.b', 'c.d', 'e.f']],
    ['a code the contract does not have', ['a.b']],
  ])('%s fails the generation', (_name, codes) => {
    expect(() => buildModel(fixture(schemas), codes)).toThrow('contract:generate')
  })
})
