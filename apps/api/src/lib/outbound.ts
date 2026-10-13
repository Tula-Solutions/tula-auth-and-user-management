import { lookup } from 'node:dns/promises'
import { type ClientRequest, request as httpRequest, type IncomingMessage } from 'node:http'
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from 'node:https'
import { rootCertificates } from 'node:tls'
import type { Tier } from '~/env'

/** Parse a dotted-quad IPv4 address into its four bytes, strictly: decimal, no leading zeros. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) {
    return null
  }
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) {
      return null
    }
    bytes.push(Number(part))
  }
  return bytes
}

/** Parse the colon-separated groups of one side of an IPv6 address into bytes. */
function parseGroups(text: string): number[] | null {
  if (text === '') {
    return []
  }
  const bytes: number[] = []
  for (const group of text.split(':')) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return null
    }
    const value = Number.parseInt(group, 16)
    bytes.push(value >> 8, value & 0xff)
  }
  return bytes
}

/** Parse an IPv6 address (no brackets, no zone) into its sixteen bytes. */
function parseIpv6(text: string): number[] | null {
  let rest = text
  let tail: number[] = []
  const lastColon = rest.lastIndexOf(':')
  // A dotted-quad tail (`::ffff:127.0.0.1`) stands for the last four bytes.
  if (rest.slice(lastColon + 1).includes('.')) {
    const embedded = parseIpv4(rest.slice(lastColon + 1))
    if (!embedded) {
      return null
    }
    tail = embedded
    // Keep both colons of a `::` that ends right before the dotted quad.
    rest = rest.slice(0, rest[lastColon - 1] === ':' ? lastColon + 1 : lastColon)
  }
  const halves = rest.split('::')
  if (halves.length > 2) {
    return null
  }
  const head = parseGroups(halves[0] ?? '')
  const end = halves.length === 2 ? parseGroups(halves[1] ?? '') : []
  if (!head || !end) {
    return null
  }
  const known = head.length + end.length + tail.length
  if (halves.length === 1) {
    return known === 16 ? [...head, ...tail] : null
  }
  // `::` stands for at least one group of zeros.
  if (known > 14) {
    return null
  }
  return [...head, ...new Array<number>(16 - known).fill(0), ...end, ...tail]
}

/** Whether `bytes` starts with the first `bits` bits of `prefix`. */
function inRange(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const width = Math.min(8, bits - bit)
    const mask = (0xff << (8 - width)) & 0xff
    if (((bytes[bit / 8] ?? 0) & mask) !== ((prefix[bit / 8] ?? 0) & mask)) {
      return false
    }
  }
  return true
}

type Range = readonly [prefix: readonly number[], bits: number]

/**
 * IPv4 ranges the server never calls: this host, private networks, carrier-grade NAT,
 * link-local (which holds the cloud metadata services), the special-purpose and documentation
 * blocks, multicast and everything reserved above it.
 */
const REFUSED_IPV4: readonly Range[] = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24],
  [[192, 88, 99], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[198, 51, 100], 24],
  [[203, 0, 113], 24],
  [[224], 3],
]

/**
 * IPv6 ranges inside global unicast (`2000::/3`) that are not public: protocol assignments
 * (Teredo among them), both documentation blocks, and 6to4, whose addresses lead to an
 * embedded IPv4 one.
 */
const REFUSED_IPV6: readonly Range[] = [
  [[0x20, 0x01, 0x00, 0x00], 23],
  [[0x20, 0x01, 0x0d, 0xb8], 32],
  [[0x20, 0x02], 16],
  [[0x3f, 0xff], 20],
]

const GLOBAL_UNICAST: Range = [[0x20], 3]
const IPV4_MAPPED: Range = [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96]
const NAT64: Range = [[0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96]

function within(bytes: readonly number[], [prefix, bits]: Range): boolean {
  return inRange(bytes, prefix, bits)
}

function isPublicIpv4(bytes: readonly number[]): boolean {
  return !REFUSED_IPV4.some((range) => within(bytes, range))
}

function isPublicIpv6(bytes: readonly number[]): boolean {
  // An address that is an IPv4 one in IPv6 clothing is judged as that IPv4 address.
  if (within(bytes, IPV4_MAPPED) || within(bytes, NAT64)) {
    return isPublicIpv4(bytes.slice(12))
  }
  // An allow-list: nothing outside global unicast is public, whatever is assigned there later.
  return within(bytes, GLOBAL_UNICAST) && !REFUSED_IPV6.some((range) => within(bytes, range))
}

/**
 * Whether an IP address is one on the public internet.
 *
 * Refused: loopback, private, link-local, carrier-grade NAT, cloud metadata, documentation,
 * multicast and reserved ranges, in IPv4 and IPv6, and an IPv6 address that carries one of
 * those IPv4 addresses (IPv4-mapped, NAT64, 6to4). Anything that is not a plain address (a
 * name, a zone id, brackets, an octal or hex octet) is refused too.
 *
 * @param address - An IPv4 or IPv6 address as text, without brackets.
 * @returns `true` only for a well-formed address outside every refused range.
 */
export function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const bytes = parseIpv6(address)
    return bytes !== null && isPublicIpv6(bytes)
  }
  const bytes = parseIpv4(address)
  return bytes !== null && isPublicIpv4(bytes)
}

/** Why an outbound request was not made, or did not finish. A closed list of fixed words. */
export type OutboundFailure =
  | 'invalid_url'
  | 'invalid_request'
  | 'scheme_not_allowed'
  | 'resolve_failed'
  | 'address_not_allowed'
  | 'connection_failed'
  | 'timeout'
  | 'response_too_large'

const FAILURE_TEXT: Record<OutboundFailure, string> = {
  invalid_url: 'The address is not a URL the server may call.',
  invalid_request: 'The request has a header or a limit that cannot be used.',
  scheme_not_allowed: 'The address must use https.',
  resolve_failed: 'The host name could not be resolved.',
  address_not_allowed: 'The host resolves to an address the server does not call.',
  connection_failed: 'The connection failed.',
  timeout: 'The request took too long.',
  response_too_large: 'The answer was larger than allowed.',
}

/**
 * An outbound request that was refused or failed.
 *
 * Its message is fixed text chosen by `reason`: never the URL, a resolved address, a header
 * or the transport's own message, so it is safe to log and to store on a delivery record.
 */
export class OutboundError extends Error {
  /** Which rule refused the request, or how it failed. */
  readonly reason: OutboundFailure
  /**
   * The HTTP status of an answer that was refused for its size (`response_too_large`): the
   * status line arrives before the body, so it is known. **A number and nothing else of the
   * answer**: no header, and no byte of the body. Absent for every other failure.
   */
  declare readonly status?: number

  /**
   * @param reason - Which rule refused the request, or how it failed.
   * @param status - The answer's HTTP status, for an answer refused for its size.
   */
  constructor(reason: OutboundFailure, status?: number) {
    super(FAILURE_TEXT[reason])
    this.name = 'OutboundError'
    this.reason = reason
    if (status !== undefined) {
      this.status = status
    }
  }
}

/**
 * A connection that was never made: nothing of the request left the server, so the next
 * address of the same answer may be tried. To a caller it is a `connection_failed` like any
 * other.
 */
class NotConnected extends OutboundError {
  constructor() {
    super('connection_failed')
  }
}

/** The transport's codes for a connection that was refused or had no route: nothing was sent. */
const NOT_CONNECTED_CODES: ReadonlySet<unknown> = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
])

/** Turns a host name into its IP addresses. Called once per request. */
export type Resolver = (hostname: string) => Promise<readonly string[]>

/** What {@link request} needs from its surroundings. */
export interface OutboundDeps {
  /** The deployment's tier. `http:` and loopback addresses are allowed in `local` only. */
  tier: Tier
  /** Defaults to the system resolver. Injected by tests. */
  resolve?: Resolver
  /**
   * A certificate authority to trust beside the system's, in PEM. For tests, which serve TLS
   * from a certificate they made; nothing in the configuration sets it.
   */
  ca?: string
}

/** One outbound request. */
export interface OutboundRequest {
  /** Defaults to `POST`. */
  method?: 'GET' | 'POST'
  /**
   * Sent as given. `Host`, `Content-Length`, `Transfer-Encoding`, `Connection` and `Upgrade`
   * are the transport's and are refused here.
   */
  headers?: Readonly<Record<string, string>>
  body?: string | Uint8Array
  /** Deadline for the whole request, name resolution included. Defaults to {@link OUTBOUND_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Largest answer body accepted. Defaults to {@link OUTBOUND_MAX_RESPONSE_BYTES}. */
  maxResponseBytes?: number
}

/** The answer to an outbound request. A redirect is an answer like any other: never followed. */
export interface OutboundResponse {
  status: number
  headers: Headers
  body: Uint8Array
}

/** Default deadline of an outbound request. */
export const OUTBOUND_TIMEOUT_MS = 10_000

/** Default cap on an answer's body: what is read from an operator's endpoint is a status and little else. */
export const OUTBOUND_MAX_RESPONSE_BYTES = 64 * 1024

const LOOPBACK_IPV4: Range = [[127], 8]
const LOOPBACK_IPV6: Range = [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128]

function isLoopbackAddress(address: string): boolean {
  if (address.includes(':')) {
    const bytes = parseIpv6(address)
    return bytes !== null && within(bytes, LOOPBACK_IPV6)
  }
  const bytes = parseIpv4(address)
  return bytes !== null && within(bytes, LOOPBACK_IPV4)
}

async function systemResolve(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map((answer) => answer.address)
}

/** The URL's host as a literal IP address, or `null` when it is a name. */
function literalAddress(url: URL): string | null {
  const host = url.hostname
  if (host.startsWith('[')) {
    return host.slice(1, -1)
  }
  // The URL parser has already turned every numeric spelling (`0x7f.1`, `2130706433`) into
  // a dotted quad, and a host name cannot end in a number.
  return parseIpv4(host) ? host : null
}

/** Reject with `timeout` when the deadline passes; otherwise settle as `work` does. */
function before<T>(deadline: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OutboundError('timeout'))
    if (deadline.aborted) {
      onAbort()
      return
    }
    deadline.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => deadline.removeEventListener('abort', onAbort))
  })
}

/**
 * The addresses the request may be sent to, in the resolver's order.
 *
 * The name is resolved here and nowhere else: the connection is made to an address this
 * returns, so a second answer from the name server (DNS rebinding) is never asked for. Every
 * address of the answer must be allowed, not only the one used.
 */
async function pinnedAddresses(
  deps: OutboundDeps,
  url: URL,
  deadline: AbortSignal
): Promise<readonly string[]> {
  const literal = literalAddress(url)
  let addresses: readonly string[]
  if (literal !== null) {
    addresses = [literal]
  } else {
    try {
      addresses = await before(deadline, (deps.resolve ?? systemResolve)(url.hostname))
    } catch (error) {
      throw error instanceof OutboundError ? error : new OutboundError('resolve_failed')
    }
  }
  if (addresses.length === 0) {
    throw new OutboundError('resolve_failed')
  }
  const allowed = (address: string) =>
    isPublicAddress(address) || (deps.tier === 'local' && isLoopbackAddress(address))
  if (!addresses.every(allowed)) {
    throw new OutboundError('address_not_allowed')
  }
  return addresses
}

/** Headers that say how the request is framed or routed: the transport's to set, never a caller's. */
const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
])

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// Visible characters, space and tab: no line break can start a second header.
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

/**
 * Refuse what the transport would throw on, with its own text, before anything is sent: a
 * header that is not one (a line break in it would add a header of the caller's data's
 * choosing) and a limit that is not a usable number.
 */
function checkRequest(init: OutboundRequest): { timeoutMs: number; limit: number } {
  const timeoutMs = init.timeoutMs ?? OUTBOUND_TIMEOUT_MS
  const limit = init.maxResponseBytes ?? OUTBOUND_MAX_RESPONSE_BYTES
  const usable =
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && Number.isSafeInteger(limit) && limit >= 0
  const headers = Object.entries(init.headers ?? {})
  const sendable = ([name, value]: [string, string]) =>
    HEADER_NAME.test(name) && HEADER_VALUE.test(value) && !TRANSPORT_HEADERS.has(name.toLowerCase())
  if (!usable || !headers.every(sendable)) {
    throw new OutboundError('invalid_request')
  }
  return { timeoutMs, limit }
}

function send(
  deps: OutboundDeps,
  url: URL,
  address: string,
  init: OutboundRequest,
  limit: number,
  deadline: AbortSignal
): Promise<OutboundResponse> {
  const secure = url.protocol === 'https:'
  return new Promise<OutboundResponse>((resolve, reject) => {
    let outgoing: ClientRequest | undefined
    const fail = (reason: OutboundFailure, status?: number) => {
      // Before anything else: the socket goes, so nothing more of the answer is taken in.
      outgoing?.destroy()
      reject(new OutboundError(reason, status))
    }
    const options: HttpsRequestOptions = {
      // The checked address, not the name: nothing is resolved again.
      host: address,
      family: address.includes(':') ? 6 : 4,
      port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
      method: init.method ?? 'POST',
      path: `${url.pathname}${url.search}`,
      headers: { 'user-agent': 'tula-auth', ...init.headers, host: url.host },
      // A connection of its own: one kept alive could have been opened for another address.
      agent: false,
      signal: deadline,
    }
    if (secure) {
      // Said here, so that `NODE_TLS_REJECT_UNAUTHORIZED=0`, set for some other dependency,
      // does not switch the check off for an operator's endpoint.
      options.rejectUnauthorized = true
      // The certificate is checked against the name the operator typed, not the address.
      if (literalAddress(url) === null) {
        options.servername = url.hostname
      }
      if (deps.ca !== undefined) {
        options.ca = [...rootCertificates, deps.ca]
      }
    }
    const onResponse = (incoming: IncomingMessage) => {
      const declared = Number(incoming.headers['content-length'] ?? 0)
      // The status line is here already. An answer refused for its size still says what
      // its status was (a webhook receiver that answered 2xx did take the event); nothing
      // else of it is kept.
      const tooLarge = () => fail('response_too_large', incoming.statusCode)
      if (declared > limit) {
        tooLarge()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          // Dropped with what was read so far: `chunks` never reaches a caller.
          chunks.length = 0
          tooLarge()
          return
        }
        chunks.push(chunk)
      })
      incoming.on('end', () => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : [value ?? '']) {
            headers.append(name, item)
          }
        }
        resolve({
          status: incoming.statusCode ?? 0,
          headers,
          body: new Uint8Array(Buffer.concat(chunks)),
        })
      })
      incoming.on('error', () => fail(deadline.aborted ? 'timeout' : 'connection_failed'))
    }
    try {
      outgoing = (secure ? httpsRequest : httpRequest)(options, onResponse)
      outgoing.on('error', (error: { code?: unknown }) => {
        if (!deadline.aborted && NOT_CONNECTED_CODES.has(error.code)) {
          reject(new NotConnected())
          return
        }
        fail(deadline.aborted ? 'timeout' : 'connection_failed')
      })
      outgoing.end(init.body)
    } catch {
      // The transport refused to build the request. Its message can quote a header: dropped.
      fail('invalid_request')
    }
  })
}

/**
 * The URL as one the server may call at all, judged by what is written in it: `https` (`http`
 * in the `local` tier), a host, no credentials. Where it leads is {@link pinnedAddresses}'.
 *
 * @throws OutboundError `invalid_url` or `scheme_not_allowed`.
 */
function callableUrl(deps: OutboundDeps, url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new OutboundError('invalid_url')
  }
  const plain = parsed.protocol === 'http:' && deps.tier === 'local'
  if (parsed.protocol !== 'https:' && !plain) {
    throw new OutboundError(parsed.protocol === 'http:' ? 'scheme_not_allowed' : 'invalid_url')
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') {
    throw new OutboundError('invalid_url')
  }
  return parsed
}

/** Default deadline of {@link check}: it only resolves a name, and a request is waiting on it. */
export const OUTBOUND_CHECK_TIMEOUT_MS = 5_000

/**
 * Judge an address an operator typed by the rules of {@link request}, and send nothing.
 *
 * For the moment an address is saved: the scheme, the credentials, and where the host leads
 * **now** (it is resolved, and every address it has must be one the server calls). It makes no
 * connection, so it says nothing about whether anything listens there.
 *
 * Passing this is not a licence to call the address later: a name can be pointed elsewhere
 * after it was saved. Every call still goes through {@link request}, which resolves and judges
 * again.
 *
 * @param deps - The tier, and the resolver in tests.
 * @param url - The operator's URL.
 * @param timeoutMs - Deadline for resolving the name. Defaults to {@link OUTBOUND_CHECK_TIMEOUT_MS}.
 * @throws OutboundError with the `reason` the address is refused for: `invalid_url`,
 *   `scheme_not_allowed`, `resolve_failed`, `address_not_allowed`, `timeout`, or
 *   `invalid_request` for a deadline that is not a usable number.
 * @example
 * await Outbound.check(deps.outbound, input.url)
 */
export async function check(
  deps: OutboundDeps,
  url: string,
  timeoutMs: number = OUTBOUND_CHECK_TIMEOUT_MS
): Promise<void> {
  const parsed = callableUrl(deps, url)
  const { timeoutMs: deadline } = checkRequest({ timeoutMs })
  await pinnedAddresses(deps, parsed, AbortSignal.timeout(deadline))
}

/**
 * Call an address an operator typed. The only way the server does so.
 *
 * An operator's URL can name anything the server can reach: its own loopback services, the
 * private network, a cloud's metadata service. So: `https` only (`http` in the `local` tier);
 * no credentials in the URL; the host resolved once and the connection made to that address;
 * every resolved address public (loopback too in the `local` tier); the certificate always
 * checked; no redirect followed; no proxy taken from the environment; one deadline for the
 * whole request; a capped answer.
 *
 * @param deps - The tier, and the resolver in tests.
 * @param url - The operator's URL.
 * @param init - Method, headers, body and limits.
 * @returns The answer, whatever its status. A 3xx is returned, not followed.
 * @throws OutboundError with the `reason` the request was refused or failed for.
 * @example
 * const answer = await Outbound.request({ tier: deps.config.tier }, endpoint.url, {
 *   headers: { 'content-type': 'application/json' },
 *   body: JSON.stringify(payload),
 * })
 */
export async function request(
  deps: OutboundDeps,
  url: string,
  init: OutboundRequest = {}
): Promise<OutboundResponse> {
  const parsed = callableUrl(deps, url)
  const { timeoutMs, limit } = checkRequest(init)
  const deadline = AbortSignal.timeout(timeoutMs)
  const addresses = await pinnedAddresses(deps, parsed, deadline)
  // A host with several addresses (IPv6 and IPv4) is tried at each in turn, under the one
  // deadline and from the one answer: an address the server has no route to must not fail
  // every delivery. Only a connection that was never made moves on: once an address may
  // have received the request, sending it to another would deliver it twice.
  for (const [index, address] of addresses.entries()) {
    try {
      return await before(deadline, send(deps, parsed, address, init, limit, deadline))
    } catch (error) {
      if (!(error instanceof NotConnected) || index === addresses.length - 1) {
        throw error
      }
    }
  }
  throw new OutboundError('resolve_failed')
}
