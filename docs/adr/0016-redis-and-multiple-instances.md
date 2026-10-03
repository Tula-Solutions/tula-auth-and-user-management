# ADR 0016 — Redis and more than one instance

- Status: accepted
- Date: 2026-10-03

## Context

Three pieces of state lived in the memory of the API process: rate-limit counters, the password
lockout (ADR 0011) and the list of revoked sessions (ADR 0008). That is correct for exactly one
process. With two, every limit doubles, an attacker gets twice the password guesses, and a
session revoked on one instance keeps working on the other until its access token expires. A
restart forgets all three. A fourth piece, each instance's cache of an environment's signing
keys (ADR 0004), was already safe across instances but slow to converge after a rotation.

The ports were in place from the start (`RateLimiter`, `Lockout`, `RevokedSessions`). This
record decides what stands behind them when there is more than one instance, and what happens
when that store cannot be reached.

## Decision

**Redis holds the shared state**, through three adapters in `apps/api/src/adapters/redis/`,
chosen in `container.ts` when `REDIS_URL` is set. `REDIS_URL` is required in `staging` and
`prod` (the API refuses to start without it) and optional in `local` and `dev`, where the
memory adapters are used when it is absent. A live deployment is therefore always safe to
scale; nobody has to remember to add Redis before adding a second instance.

**The client is Bun's built-in `RedisClient`.** No dependency is added. The adapters depend on
one method, `send(command, args)`, so they do not know which client they have.

**Each decision is one Lua script.** Counting a request, registering a password attempt and
recording a revocation are each a read, a decision and a write. Redis runs a script to
completion before anything else, so requests that reach different instances at the same moment
are handled one after another: a limit is never exceeded between them, an attempt is counted
exactly once, and a revocation never shortens one that lasts longer.

**The application's clock decides; Redis's expiry only cleans up.** Every entry stores its own
timestamps (window start, locked-until, forget-at, revoked-until), and the scripts compare them
with the time the calling instance passes in, as the ports already require. Key expiry is set
so that entries remove themselves, a little later than the application needs them
(`CLOCK_SKEW_ALLOWANCE_MS`, 30 seconds, for lockout and revoked sessions). Two things follow:
the same behaviour suites run against the memory adapters, a fake and a real Redis with a test
clock; and instances are assumed to keep time with each other, as NTP provides. A skew shifts
the end of a window or a wait by that much.

**No personal data is written to Redis.**

| Key | Value | Lives for |
| --- | --- | --- |
| `tula:rl:<HMAC of the bucket name>` | window start, count, window length | the rest of the window |
| `tula:lo:<lockout key>` | failures, locked-until, forget-at | until forgotten, plus the allowance |
| `tula:rs:<session id>` | revoked-until | until the last access token expires, plus the allowance |
| `tula:sk:<environment id>` | a random marker | 30 days |

Rate-limit bucket names contain client IP addresses, so the key is an HMAC-SHA256 of the name,
keyed from `TULA_MASTER_KEY`; a plain hash of an IPv4 address could be reversed by trying all of
them. Lockout keys are built by callers from ids and hashes only (the sign-in key hashes the
identifier), and session and environment ids are random.

**When Redis cannot answer, the API refuses rather than guesses.** A command that fails, times
out (one second) or returns something unexpected becomes the contract error
`service.unavailable` (503), a new code. Specifically:

- *Rate limits and lockout fail closed.* A sign-in, sign-up, code or password request is
  refused with 503. Not even a correct password is checked while attempts cannot be counted;
  otherwise an attacker who can disturb Redis gets unlimited guesses.
- *The revoked-session check fails closed.* A request with an access token is refused with 503:
  a token is not accepted while nobody can say whether its session was revoked.
- *Revoking is refused, not half done.* The session service adds to the list before it revokes
  in Postgres (ADR 0008), so sign-out, revoke and a detected refresh-token reuse answer 503 and
  change nothing; the client retries.
- *Refresh keeps working.* It needs only Postgres, and a refresh token is 256 bits, so its
  limits protect the database rather than a secret. A rate-limit rule can be marked
  `whenUnavailable: 'allow'`; it then lets the request through uncounted and logs a warning.
  Four rules are: the per-IP ceiling in front of every client route, refresh, the public JWKS
  (services verifying tokens depend on it) and `/v1/ready` (so it can report the failure).
  Every other rule, including all of `/v1/admin/*`, refuses.
- Signed-in users therefore keep their sessions through a Redis outage, but can do nothing
  with them until it ends, and nobody can sign in.

Nothing falls back to process memory. A fallback would silently restore the per-instance
behaviour this record exists to remove, at the moment an attacker is most likely to want it.

**The connection fails fast and heals itself.** Commands are never queued while disconnected:
they are refused at once, so requests do not pile up waiting. A command that finds the
connection down starts one connection attempt shared by every waiting command, and after a
failed attempt commands are refused for a second before the next one. Bun's own reconnection is
switched off because it gives up permanently after a fixed number of tries. Failures are logged
with the error's name and code only; a client's message can quote the connection string.

**Readiness.** `/v1/ready` sends `PING` and reports `redis: ok | fail` next to `database` when
Redis is configured.

**Signing-key caches converge through a marker.** When an instance inserts or rotates an
environment's keys it replaces a random marker in Redis. Every instance compares the marker it
saw when it fetched its cached keys with the current one at most every 5 seconds per
environment, and refetches from Postgres when they differ. So another instance serves keys that
predate a rotation for at most 5 seconds after the marker was written. If the marker cannot be
written or read, nothing fails: the cache's own 60-second lifetime applies, as it did before,
and the rotation invariant (a key is published for at least one cache lifetime before it signs)
already makes that safe. A marker checked on a timer was chosen over publish/subscribe because
it needs no second connection and has no lost-message case to reason about; the price is the
5-second bound instead of a near-instant one.

**Tests.** Each port has a behaviour suite (`adapters/*.suite.ts`) run against the memory
adapter, the Redis adapter on an in-memory fake (unit tests: no Docker, no network), and the
Redis adapter on a real server (`redis.integration.ts`, run by `bun run test:integration` and
in CI). The fake cannot run Lua; it restates each script in TypeScript, so the real-server run
is what proves the scripts and what would catch the fake drifting from them.

**The packaged stack runs two instances, and CI proves they share their state.** The Compose
`app` profile starts `api` and `api-2`: the same image and the same settings (one YAML anchor),
differing only in the host port (3003 and 3004). Each instance is published on its own port
instead of both sitting behind a proxy, because the point of the example is to let a test, or
a curious self-hoster, talk to each one separately; a real deployment puts a load balancer in
front and publishes nothing else. They must share `PUBLIC_URL`: it is the issuer of every
access token, so a token signed by one is only accepted by the other if they agree on it.

The conformance format gained one optional field, `instance: "second"` on a request, and the
runner an optional second base URL (`CONFORMANCE_SECOND_BASE_URL`). The `two instances`
scenario signs up through the first instance, uses and then ends the session through the
second, shows the first refusing the access token at once, and alternates six wrong passwords
between the two before both refuse the seventh. With no second instance configured every step
goes to the one server and the scenario still passes, so the scenario files stay valid for any
server and any SDK; in process the second instance is a second `createApp` over the same
stores. The `self-host` CI job runs the whole suite against both containers and fails unless
that scenario passed against two distinct URLs. This was chosen over a separate script because
it was a small additive change, and it puts the cross-instance behaviour in the same files
every SDK will run.

**Background jobs take a lock in Postgres, not Redis.** Two instances also means two copies of
every timer. The retention job runs on one instance at a time through a Postgres advisory lock
([ADR 0017](0017-retention.md)).

## Consequences

- **Redis is on the critical path in production.** An outage stops sign-in and every
  authenticated request until it ends. That is the price of failing closed; run Redis with the
  same care as the database. Losing its data (a restart without persistence) costs little:
  counters and lockouts start again, and a session revoked within the last minute can use its
  access token until that token expires.
- **Each request costs Redis round trips**: one per rate-limit rule it passes, one for an
  authenticated request, one or two for a password attempt. Scripts are sent in full each time
  (`EVAL`); `EVALSHA` is a possible optimization.
- **Rate-limit counters cannot be read by key name** in Redis, because names are HMACs.
  Changing `TULA_MASTER_KEY` renames every bucket, which resets the counters.
- **A single Redis is assumed.** The scripts touch one key each, so Redis Cluster would work,
  but neither it nor Sentinel has been tested.
- **Clock skew between instances** moves window and lockout boundaries by the skew. Instances
  far out of sync would be a problem for token expiry long before this.
- `service.unavailable` is a new error code and a new 503 response on most routes: additive,
  and clients should treat it as "retry shortly".
- With `REDIS_URL` unset (`local`, `dev`) everything in "Context" still applies; that
  configuration is for one instance.
