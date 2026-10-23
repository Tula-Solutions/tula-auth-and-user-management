// The grammar of a verified domain and the list of public mail domains (ADR 0065, "Verified
// domains"), with no dependency: the entry point a form or a server loads at run time to say
// whether a domain can be claimed, without pulling Zod into an application's bundle. The Zod
// schemas of the requests are in `./organization-domain`, built from these.

/** Longest a whole domain can be, in characters (RFC 1035). */
export const MAX_DOMAIN_LENGTH = 253

/** Longest one label of a domain can be, in characters (RFC 1035). */
export const MAX_DOMAIN_LABEL_LENGTH = 63

/** Shortest a domain can be: `a.bc`. */
export const MIN_DOMAIN_LENGTH = 4

/**
 * How many domains one organization can claim, verified or waiting for a code. A bound so that
 * a signed-in administrator cannot fill the table.
 */
export const MAX_DOMAINS_PER_ORGANIZATION = 10

/** How an organization treats a user who signs up with a verified address on its domain. */
export const ORGANIZATION_DOMAIN_MODES = ['suggest', 'auto_join'] as const

/** One of {@link ORGANIZATION_DOMAIN_MODES}. */
export type OrganizationDomainMode = (typeof ORGANIZATION_DOMAIN_MODES)[number]

/**
 * The grammar of a claimable domain: two or more labels of lower-case ASCII letters, digits
 * and hyphens (none at a label's end), joined by single full stops, the last label letters
 * only (or punycode, `xn--…`). So: no upper case, no trailing full stop, no port or path, no
 * underscore, no `@`, no wildcard, and no IP address (a numeric last label is refused, and so
 * is the bracketed IPv6 form).
 *
 * **Internationalised domains are written in punycode** (`xn--bcher-kva.example`, never
 * `bücher.example`): Unicode is refused, not converted, so a domain is stored and compared in
 * the one spelling a mail server uses. The pattern is the grammar alone; the length bounds
 * ({@link MAX_DOMAIN_LENGTH}, {@link MAX_DOMAIN_LABEL_LENGTH}) and the public list are
 * {@link domainRefusal}'s. `domainRefusal` runs it only over text of at most twice the length cap, so its work is bounded.
 *
 * @example
 * ```ts
 * DOMAIN_PATTERN.test('acme.com') // true
 * DOMAIN_PATTERN.test('Acme.com') // false
 * DOMAIN_PATTERN.test('192.168.0.1') // false
 * ```
 */
export const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]*[a-z0-9])$/

/** Why a string is not a claimable domain. */
export type DomainRefusal = 'grammar' | 'length' | 'public'

/**
 * Domains that anyone can get an address at, and that so prove nothing about the holder of an
 * address on them. **Documented here and nowhere else**: a claim of one is refused
 * (`organization.domain_public`) and a join never matches one, even a claim stored before the
 * list grew. The list is the large free consumer mailbox providers, the internet providers
 * that give every customer an address, and the common national ones; a company's own domain
 * is never on it.
 *
 * Providers that sell a mailbox under many country domains (`yahoo.co.uk`, `yahoo.fr`,
 * `hotmail.de`, …) are in {@link PUBLIC_EMAIL_BRANDS} instead.
 */
export const PUBLIC_EMAIL_DOMAINS: readonly string[] = [
  // Google, Microsoft, Apple, Proton, AOL and Yahoo's other names
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'passport.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'aol.com',
  'aim.com',
  'ymail.com',
  'rocketmail.com',
  // Other free or privacy-minded providers
  'mail.com',
  'email.com',
  'zoho.com',
  'zohomail.com',
  'fastmail.com',
  'fastmail.fm',
  'hey.com',
  'tutanota.com',
  'tutanota.de',
  'tutamail.com',
  'tuta.io',
  'tuta.com',
  'hushmail.com',
  'yandex.com',
  'yandex.ru',
  'ya.ru',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'gmx.at',
  'gmx.ch',
  'web.de',
  'freenet.de',
  't-online.de',
  'posteo.de',
  'mailbox.org',
  'runbox.com',
  // Internet providers that hand out addresses to their customers
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'btinternet.com',
  'virginmedia.com',
  'sky.com',
  'talktalk.net',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'laposte.net',
  'sfr.fr',
  'libero.it',
  'virgilio.it',
  'tiscali.it',
  'wp.pl',
  'o2.pl',
  'onet.pl',
  'interia.pl',
  'seznam.cz',
  'rediffmail.com',
  'qq.com',
  '163.com',
  '126.com',
  'sina.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
]

/**
 * Provider names whose every country domain is public: `yahoo.com`, `yahoo.co.uk`, `yahoo.fr`
 * and `yahoo.co.jp` are all `yahoo`. A domain matches when its **first** label is one of
 * these and what follows is a top-level domain, or a short second-level one and a top-level
 * one (`co.uk`, `com.br`): `yahoo.com` and `hotmail.co.uk` match, `yahoo.acme.com` and
 * `notyahoo.com` do not.
 */
export const PUBLIC_EMAIL_BRANDS: readonly string[] = [
  'yahoo',
  'hotmail',
  'outlook',
  'live',
  'gmail',
  'icloud',
  'protonmail',
]

const PUBLIC_DOMAINS = new Set(PUBLIC_EMAIL_DOMAINS)

const BRAND_PATTERN = new RegExp(
  `^(?:${PUBLIC_EMAIL_BRANDS.join('|')})\\.(?:(?:co|com|net|org|ne|or|ac|gov|edu)\\.)?[a-z]{2,}$`
)

/**
 * Whether anyone can get an address on this domain: it is on {@link PUBLIC_EMAIL_DOMAINS} or
 * is a country domain of one of {@link PUBLIC_EMAIL_BRANDS}.
 *
 * @param domain - A domain in the spelling of {@link DOMAIN_PATTERN}.
 * @returns `true` for a public mail domain.
 * @example
 * ```ts
 * isPublicEmailDomain('gmail.com') // true
 * isPublicEmailDomain('yahoo.co.uk') // true
 * isPublicEmailDomain('acme.com') // false
 * ```
 */
export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_DOMAINS.has(domain) || BRAND_PATTERN.test(domain)
}

/**
 * Why a string cannot be claimed as a domain, or `null` when it can.
 *
 * @param domain - The text to judge.
 * @returns `grammar` (not a lower-case ASCII domain name: upper case, Unicode, an IP address,
 *   a single label), `length` (a label over {@link MAX_DOMAIN_LABEL_LENGTH}, the whole over
 *   {@link MAX_DOMAIN_LENGTH} or under {@link MIN_DOMAIN_LENGTH}), `public` (a public mail
 *   domain), or `null`.
 * @example
 * ```ts
 * domainRefusal('acme.com') // null
 * domainRefusal('gmail.com') // 'public'
 * domainRefusal('bücher.example') // 'grammar'
 * ```
 */
export function domainRefusal(domain: string): DomainRefusal | null {
  // The grammar first: a text that is not a domain is not "too long" to anyone. The pattern
  // runs over at most a few hundred characters (the length is capped before it).
  if (domain.length > 2 * MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(domain)) {
    return 'grammar'
  }
  if (
    domain.length > MAX_DOMAIN_LENGTH ||
    domain.length < MIN_DOMAIN_LENGTH ||
    domain.split('.').some((label) => label.length > MAX_DOMAIN_LABEL_LENGTH)
  ) {
    return 'length'
  }
  return isPublicEmailDomain(domain) ? 'public' : null
}

/**
 * The domain of an email address in the spelling the server stores (lower case), or `null`
 * when the text has no `@` or ends in one.
 *
 * It is everything after the **last** `@`, unchanged: no subdomain is cut off, so
 * `a@mail.acme.com` is `mail.acme.com` and **never** matches a claim on `acme.com`. Whether the
 * result is a domain at all is {@link domainRefusal}'s question.
 *
 * @param address - An email address, normalised (lower case) by the caller.
 * @returns The part after the last `@`, or `null`.
 * @example
 * ```ts
 * domainOfAddress('ada@acme.com') // 'acme.com'
 * domainOfAddress('ada@mail.acme.com') // 'mail.acme.com'
 * ```
 */
export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf('@')
  if (at < 1 || at === address.length - 1) {
    return null
  }
  return address.slice(at + 1)
}
