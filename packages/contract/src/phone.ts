// Phone numbers as plain data: the E.164 shape, and which countries a number's calling code
// belongs to. No Zod and no dependency: the table is what the SMS country allow-list
// (`sms.allowedCountries` in an environment's settings) is matched against.

/** Fewest digits of an E.164 number Tula accepts (after the `+`). */
export const MIN_PHONE_NUMBER_DIGITS = 8

/** Most digits of an E.164 number (after the `+`): the limit of ITU-T E.164. */
export const MAX_PHONE_NUMBER_DIGITS = 15

const E164 = new RegExp(
  `^\\+[1-9][0-9]{${MIN_PHONE_NUMBER_DIGITS - 1},${MAX_PHONE_NUMBER_DIGITS - 1}}$`
)

// What people type between the digits. Nothing else is taken out: a letter, a dot, a slash, an
// extension or a second `+` makes the input something other than one number.
const SEPARATORS = /[ ()-]/g

/**
 * Read a phone number as a person typed it and return it in E.164 form.
 *
 * The only tidying is taking out spaces, hyphens and parentheses. What is left must be a `+`,
 * then {@link MIN_PHONE_NUMBER_DIGITS} to {@link MAX_PHONE_NUMBER_DIGITS} digits, the first of
 * which is not `0`. A national number (`0171 …`), a `00` prefix, letters and any other
 * punctuation are refused rather than guessed at: guessing a country is how a code ends up on
 * somebody else's phone.
 *
 * This says the input has the shape of a number, not that the number exists.
 *
 * @param input - The number as entered.
 * @returns The number in E.164 form, or `null` when the input is not one.
 *
 * @example
 * ```ts
 * parsePhoneNumber('+1 (415) 555-0100') // '+14155550100'
 * parsePhoneNumber('0171 5550100') // null: no country calling code
 * ```
 */
export function parsePhoneNumber(input: string): string | null {
  const number = input.replace(SEPARATORS, '')
  return E164.test(number) ? number : null
}

/**
 * Mask a phone number for display: its last two digits behind a fixed-width mask.
 *
 * @param phoneNumber - A number in E.164 form.
 * @returns The mask, e.g. `***00`.
 *
 * @example
 * ```ts
 * maskPhoneNumber('+14155550100') // '***00'
 * ```
 */
export function maskPhoneNumber(phoneNumber: string): string {
  return `***${phoneNumber.slice(-2)}`
}

/**
 * The prefixes of the E.164 numbers of each country, by ISO 3166-1 alpha-2 code (plus `XK`,
 * the user-assigned code in common use for Kosovo).
 *
 * A prefix is a country calling code, or a calling code and the leading digits that tell one
 * country's numbers from another's inside a shared code (the Caribbean members of `+1`,
 * Kazakhstan inside `+7`). **Countries that share a prefix cannot be told apart by this
 * table**, and are treated as one destination by {@link phoneNumberCountries}: the United
 * States and Canada (`+1`), the United Kingdom and the Crown Dependencies (`+44`), Italy and
 * the Vatican (`+39`), and a few more.
 *
 * It is here for the SMS country allow-list and holds nothing else about a country: no
 * number lengths, no line types, no names.
 */
export const COUNTRY_CALLING_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  AD: ['376'],
  AE: ['971'],
  AF: ['93'],
  AG: ['1268'],
  AI: ['1264'],
  AL: ['355'],
  AM: ['374'],
  AO: ['244'],
  AR: ['54'],
  AS: ['1684'],
  AT: ['43'],
  AU: ['61'],
  AW: ['297'],
  AX: ['358'],
  AZ: ['994'],
  BA: ['387'],
  BB: ['1246'],
  BD: ['880'],
  BE: ['32'],
  BF: ['226'],
  BG: ['359'],
  BH: ['973'],
  BI: ['257'],
  BJ: ['229'],
  BL: ['590'],
  BM: ['1441'],
  BN: ['673'],
  BO: ['591'],
  BQ: ['5993', '5994', '5997'],
  BR: ['55'],
  BS: ['1242'],
  BT: ['975'],
  BW: ['267'],
  BY: ['375'],
  BZ: ['501'],
  CA: ['1'],
  CC: ['61'],
  CD: ['243'],
  CF: ['236'],
  CG: ['242'],
  CH: ['41'],
  CI: ['225'],
  CK: ['682'],
  CL: ['56'],
  CM: ['237'],
  CN: ['86'],
  CO: ['57'],
  CR: ['506'],
  CU: ['53'],
  CV: ['238'],
  CW: ['5999'],
  CX: ['61'],
  CY: ['357'],
  CZ: ['420'],
  DE: ['49'],
  DJ: ['253'],
  DK: ['45'],
  DM: ['1767'],
  DO: ['1809', '1829', '1849'],
  DZ: ['213'],
  EC: ['593'],
  EE: ['372'],
  EG: ['20'],
  EH: ['212'],
  ER: ['291'],
  ES: ['34'],
  ET: ['251'],
  FI: ['358'],
  FJ: ['679'],
  FK: ['500'],
  FM: ['691'],
  FO: ['298'],
  FR: ['33'],
  GA: ['241'],
  GB: ['44'],
  GD: ['1473'],
  GE: ['995'],
  GF: ['594'],
  GG: ['44'],
  GH: ['233'],
  GI: ['350'],
  GL: ['299'],
  GM: ['220'],
  GN: ['224'],
  GP: ['590'],
  GQ: ['240'],
  GR: ['30'],
  GT: ['502'],
  GU: ['1671'],
  GW: ['245'],
  GY: ['592'],
  HK: ['852'],
  HN: ['504'],
  HR: ['385'],
  HT: ['509'],
  HU: ['36'],
  ID: ['62'],
  IE: ['353'],
  IL: ['972'],
  IM: ['44'],
  IN: ['91'],
  IO: ['246'],
  IQ: ['964'],
  IR: ['98'],
  IS: ['354'],
  IT: ['39'],
  JE: ['44'],
  JM: ['1658', '1876'],
  JO: ['962'],
  JP: ['81'],
  KE: ['254'],
  KG: ['996'],
  KH: ['855'],
  KI: ['686'],
  KM: ['269'],
  KN: ['1869'],
  KP: ['850'],
  KR: ['82'],
  KW: ['965'],
  KY: ['1345'],
  KZ: ['76', '77'],
  LA: ['856'],
  LB: ['961'],
  LC: ['1758'],
  LI: ['423'],
  LK: ['94'],
  LR: ['231'],
  LS: ['266'],
  LT: ['370'],
  LU: ['352'],
  LV: ['371'],
  LY: ['218'],
  MA: ['212'],
  MC: ['377'],
  MD: ['373'],
  ME: ['382'],
  MF: ['590'],
  MG: ['261'],
  MH: ['692'],
  MK: ['389'],
  ML: ['223'],
  MM: ['95'],
  MN: ['976'],
  MO: ['853'],
  MP: ['1670'],
  MQ: ['596'],
  MR: ['222'],
  MS: ['1664'],
  MT: ['356'],
  MU: ['230'],
  MV: ['960'],
  MW: ['265'],
  MX: ['52'],
  MY: ['60'],
  MZ: ['258'],
  NA: ['264'],
  NC: ['687'],
  NE: ['227'],
  NF: ['672'],
  NG: ['234'],
  NI: ['505'],
  NL: ['31'],
  NO: ['47'],
  NP: ['977'],
  NR: ['674'],
  NU: ['683'],
  NZ: ['64'],
  OM: ['968'],
  PA: ['507'],
  PE: ['51'],
  PF: ['689'],
  PG: ['675'],
  PH: ['63'],
  PK: ['92'],
  PL: ['48'],
  PM: ['508'],
  PR: ['1787', '1939'],
  PS: ['970'],
  PT: ['351'],
  PW: ['680'],
  PY: ['595'],
  QA: ['974'],
  RE: ['262'],
  RO: ['40'],
  RS: ['381'],
  RU: ['7'],
  RW: ['250'],
  SA: ['966'],
  SB: ['677'],
  SC: ['248'],
  SD: ['249'],
  SE: ['46'],
  SG: ['65'],
  SH: ['290'],
  SI: ['386'],
  SJ: ['47'],
  SK: ['421'],
  SL: ['232'],
  SM: ['378'],
  SN: ['221'],
  SO: ['252'],
  SR: ['597'],
  SS: ['211'],
  ST: ['239'],
  SV: ['503'],
  SX: ['1721'],
  SY: ['963'],
  SZ: ['268'],
  TC: ['1649'],
  TD: ['235'],
  TG: ['228'],
  TH: ['66'],
  TJ: ['992'],
  TK: ['690'],
  TL: ['670'],
  TM: ['993'],
  TN: ['216'],
  TO: ['676'],
  TR: ['90'],
  TT: ['1868'],
  TV: ['688'],
  TW: ['886'],
  TZ: ['255'],
  UA: ['380'],
  UG: ['256'],
  US: ['1'],
  UY: ['598'],
  UZ: ['998'],
  VA: ['39'],
  VC: ['1784'],
  VE: ['58'],
  VG: ['1284'],
  VI: ['1340'],
  VN: ['84'],
  VU: ['678'],
  WF: ['681'],
  WS: ['685'],
  XK: ['383'],
  YE: ['967'],
  YT: ['262'],
  ZA: ['27'],
  ZM: ['260'],
  ZW: ['263'],
}

/** Every country code of {@link COUNTRY_CALLING_PREFIXES}, in alphabetical order. */
export const SMS_COUNTRIES: readonly string[] = Object.keys(COUNTRY_CALLING_PREFIXES).sort()

const COUNTRIES_BY_PREFIX: ReadonlyMap<string, readonly string[]> = (() => {
  const byPrefix = new Map<string, string[]>()
  for (const country of SMS_COUNTRIES) {
    for (const prefix of COUNTRY_CALLING_PREFIXES[country] ?? []) {
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), country])
    }
  }
  return byPrefix
})()

const LONGEST_PREFIX = Math.max(...[...COUNTRIES_BY_PREFIX.keys()].map((prefix) => prefix.length))

/**
 * Whether a string is a country code the SMS allow-list accepts: upper case, and a key of
 * {@link COUNTRY_CALLING_PREFIXES}.
 *
 * @param value - The candidate.
 * @returns `true` for a known country code.
 *
 * @example
 * ```ts
 * isSmsCountry('DE') // true
 * isSmsCountry('de') // false
 * ```
 */
export function isSmsCountry(value: string): boolean {
  return Object.hasOwn(COUNTRY_CALLING_PREFIXES, value)
}

/**
 * The countries a number may belong to, by the **longest** prefix of the table it starts with.
 *
 * Longest, so that `+1 242 …` is the Bahamas and never "the United States or Canada": the
 * shorter prefix is the cheaper destination, and a match on it would let a number of the
 * dearer one through an allow-list that names only the cheaper.
 *
 * @param phoneNumber - A number in E.164 form.
 * @returns The country codes that share that prefix, or none for a calling code the table
 *   does not have.
 *
 * @example
 * ```ts
 * phoneNumberCountries('+4915112345678') // ['DE']
 * phoneNumberCountries('+14155550100') // ['CA', 'US']
 * phoneNumberCountries('+12425550100') // ['BS']
 * ```
 */
export function phoneNumberCountries(phoneNumber: string): readonly string[] {
  const prefix = longestPrefix(phoneNumber)
  return prefix === null ? [] : (COUNTRIES_BY_PREFIX.get(prefix) ?? [])
}

/** The longest prefix of the table a number starts with, without the `+`. */
function longestPrefix(phoneNumber: string): string | null {
  const digits = phoneNumber.replace(/^\+/, '')
  for (let length = LONGEST_PREFIX; length > 0; length -= 1) {
    const prefix = digits.slice(0, length)
    if (COUNTRIES_BY_PREFIX.has(prefix)) {
      return prefix
    }
  }
  return null
}

/**
 * Whether an SMS allow-list lets a message go to a number: one of the countries the number
 * may belong to is listed. An empty list allows nothing.
 *
 * @param phoneNumber - A number in E.164 form.
 * @param allowedCountries - The environment's `sms.allowedCountries`.
 * @returns `true` when the number's destination is allowed.
 *
 * @example
 * ```ts
 * isPhoneNumberAllowed('+4915112345678', ['DE', 'AT']) // true
 * isPhoneNumberAllowed('+4915112345678', []) // false
 * ```
 */
export function isPhoneNumberAllowed(
  phoneNumber: string,
  allowedCountries: readonly string[]
): boolean {
  return phoneNumberCountries(phoneNumber).some((country) => allowedCountries.includes(country))
}

/**
 * How many text messages an environment sends in one day (UTC) unless it says otherwise: the
 * default of `sms.dailyMessageLimit`. The limit is on by default, so that an attack on an
 * environment that has just switched SMS on has a fixed maximum cost (ADR 0037).
 */
export const DEFAULT_SMS_DAILY_MESSAGE_LIMIT = 500

/** The most `sms.dailyMessageLimit` can be set to. There is no value that means "no limit". */
export const MAX_SMS_DAILY_MESSAGE_LIMIT = 1_000_000

/**
 * The most digits a destination prefix has ({@link phoneNumberPrefix}): the longest entry of
 * {@link COUNTRY_CALLING_PREFIXES}. A test holds the two equal.
 */
export const SMS_PREFIX_MAX_DIGITS = 4

/**
 * The countries one destination prefix covers: every country of
 * {@link COUNTRY_CALLING_PREFIXES} that lists it. More than one for a shared prefix (`+1` is
 * the United States and Canada), which this table cannot tell apart: a reader is shown all
 * of them, never one picked out.
 *
 * It is the prefix exactly, not a number's: `+1` does not include the Bahamas, whose numbers
 * are counted under `+1242` ({@link phoneNumberPrefix}).
 *
 * @param prefix - A destination prefix, with or without its `+`.
 * @returns The country codes, in alphabetical order; none for a prefix the table does not
 *   have.
 *
 * @example
 * ```ts
 * smsPrefixCountries('+49') // ['DE']
 * smsPrefixCountries('+1') // ['CA', 'US']
 * smsPrefixCountries('+999') // []
 * ```
 */
export function smsPrefixCountries(prefix: string): readonly string[] {
  return COUNTRIES_BY_PREFIX.get(prefix.replace(/^\+/, '')) ?? []
}

/**
 * What share of the day's limit one destination prefix ({@link phoneNumberPrefix}) may take
 * in an hour: a tenth. Numbers bought to be texted are numbers of one destination, and one
 * destination must not be able to spend the day in less than ten hours. In an environment
 * that texts one country this is the hourly limit that binds.
 */
export const SMS_PREFIX_HOURLY_SHARE = 10

/**
 * What share of the day's limit the whole environment may send in an hour: a quarter. A day's
 * allowance then takes at least four hours to spend, which is time to notice.
 */
export const SMS_ENVIRONMENT_HOURLY_SHARE = 4

/** The limits one daily limit gives an environment ({@link smsCostLimits}). */
export interface SmsCostLimits {
  /** Messages an hour to the numbers of one destination prefix. */
  prefixPerHour: number
  /** Messages an hour, whatever the destination. */
  environmentPerHour: number
  /** Messages in one UTC day: the environment's `sms.dailyMessageLimit`. */
  perDay: number
}

/**
 * The limits that bound what an environment's text messages can cost, from its one setting
 * (ADR 0037). The server enforces exactly these, and the dashboard shows them from here: one
 * definition, so that what an operator reads is what is held.
 *
 * They count **messages**: not segments (a long message is billed as several) and not money.
 *
 * @param dailyMessageLimit - The environment's `sms.dailyMessageLimit`.
 * @returns The hourly limits per prefix and per environment (shares of the day's, rounded
 *   up, never below one) and the day's. A value that is not a whole number of at least one
 *   (nothing the API stores) reads as one: a broken setting must send less, never more.
 *
 * @example
 * ```ts
 * smsCostLimits(500) // { prefixPerHour: 50, environmentPerHour: 125, perDay: 500 }
 * ```
 */
export function smsCostLimits(dailyMessageLimit: number): SmsCostLimits {
  const perDay =
    Number.isInteger(dailyMessageLimit) && dailyMessageLimit >= 1 ? dailyMessageLimit : 1
  return {
    prefixPerHour: Math.ceil(perDay / SMS_PREFIX_HOURLY_SHARE),
    environmentPerHour: Math.ceil(perDay / SMS_ENVIRONMENT_HOURLY_SHARE),
    perDay,
  }
}

/**
 * The destination prefix of a number: the **longest** entry of
 * {@link COUNTRY_CALLING_PREFIXES} it starts with, with its `+`. It is the prefix the country
 * allow-list matched the number by, so a destination that is limited and counted is exactly a
 * destination that can be allowed or left out.
 *
 * It is what text messages are limited and counted by besides the number itself. A prefix is
 * a country calling code, or a calling code and the digits that tell one country from another
 * inside a shared one: it says where a message went and nothing about whose phone it reached,
 * which is why an operator may be shown it where a number never is.
 *
 * @param phoneNumber - A number in E.164 form.
 * @returns The prefix, or `null` for a calling code the table does not have (a number no
 *   allow-list lets a message go to).
 *
 * @example
 * ```ts
 * phoneNumberPrefix('+14155550100') // '+1'
 * phoneNumberPrefix('+12425550100') // '+1242'
 * phoneNumberPrefix('+99912345678') // null
 * ```
 */
export function phoneNumberPrefix(phoneNumber: string): string | null {
  const prefix = longestPrefix(phoneNumber)
  return prefix === null ? null : `+${prefix}`
}
