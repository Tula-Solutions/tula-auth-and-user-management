import { describe, expect, test } from 'bun:test'
import { OAUTH_PROVIDERS } from '@tula/contract'
import { type EmailBrand, type EmailMessage, render } from '~/modules/email/templates'

// The built-in copy, byte for byte. The snapshot was taken before email wording became
// editable (TULA-17): an environment that has saved no template must send exactly this.
// A change here is a change of what every such environment's users read; make it on purpose.

const at = new Date('2026-10-03T14:05:59.000Z')
const link = 'https://app.acme.test/auth/link#tula_link=tok&tula_attempt=att'

const CODES = (['email_verification', 'password_reset', 'sign_in', 'step_up'] as const).flatMap(
  (type): [string, EmailMessage][] => [
    [type, { type, code: '482913', ttlMinutes: 10 }],
    [`${type} with a link`, { type, code: '482913', ttlMinutes: 15, linkUrl: link }],
  ]
)

const DECOYS = (['account_exists', 'no_account', 'no_account_sign_in'] as const).map(
  (type): [string, EmailMessage] => [type, { type }]
)

const PASSWORDS = (['self', 'reset', 'admin', 'verification'] as const).flatMap((by) =>
  [false, true].map((added): [string, EmailMessage] => [
    `password_changed by ${by}${added ? ', added' : ''}`,
    { type: 'password_changed', by, added, at },
  ])
)

const MFA = (
  [
    'enabled',
    'disabled',
    'admin_reset',
    'backup_codes_regenerated',
    'backup_code_used',
    'passkey_added',
    'passkey_removed',
  ] as const
).map((change): [string, EmailMessage] => [
  `mfa_changed ${change}`,
  { type: 'mfa_changed', change, at, ...(change === 'backup_code_used' && { remaining: 9 }) },
])

const IDENTITIES = OAUTH_PROVIDERS.flatMap((provider) =>
  (['linked', 'unlinked'] as const).map((change): [string, EmailMessage] => [
    `identity_changed ${provider} ${change}`,
    { type: 'identity_changed', change, provider, at },
  ])
)

const MESSAGES: [string, EmailMessage][] = [
  ...CODES,
  ...DECOYS,
  ...PASSWORDS,
  ...MFA,
  ...IDENTITIES,
  [
    'new_sign_in',
    { type: 'new_sign_in', device: 'Chrome on Windows', at, ipAddress: '203.0.113.7' },
  ],
  ['new_sign_in with no address', { type: 'new_sign_in', device: 'Safari', at, ipAddress: null }],
]

const BRANDS: [string, EmailBrand][] = [
  ['with a support address', { name: 'Acme', supportEmail: 'help@acme.test' }],
  ['without one', { name: 'O’Neil & <Sons>', supportEmail: null }],
]

describe('the built-in copy is what it was before wording became editable', () => {
  for (const [brandName, brand] of BRANDS) {
    test.each(MESSAGES)(`%s, ${brandName}`, (_, message) => {
      expect(render(brand, message)).toMatchSnapshot()
    })
  }
})
