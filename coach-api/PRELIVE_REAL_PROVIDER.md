# C1C isolated real-provider preparation

C1D adds a persistent recovery-required marker and an internal read-only
inspection helper. See [recovery contract and future live-resource plan](PRELIVE_RECOVERY_AND_LIVE_PLAN.md)
for the operator-only fail-closed procedure, generation checks, evidence limits,
and separate owner gates. No force-clear route, alarm, or live authority is added.

`wrangler.real-prelive.jsonc` describes a separate, undeployed Worker named
`chinese-chess-coach-openai-staging`. The existing `wrangler.jsonc`, fake Worker,
browser entrypoints, C1A adapter and C1B lifecycle are unchanged. Committed enable
is `false`, daily units are `0`, no key is present and no rate binding is active.

The future Worker uses the existing strict HTTP/request/framing gates. All valid
provider requests resolve `review-coach-real-provider-global-v1` through
`COACH_REAL_COORDINATOR.getByName`. Only the coordinator executes the adapter.
Its SQL storage holds UTC-day usage totals, reservations, and one occupied slot.
Synchronous SQL transactions reserve units before dispatch. The dispatch intent
is synchronized to disk before the injected/platform fetch is called.

The Workers transport adapts C1A's `redirect: error` to `redirect: manual` because
workerd rejects `error` as unsupported. A 3xx is returned to the existing C1A
non-200 rejection/cancellation path and is never followed. The local Workers
runtime test exercises RPC, SQLite, a simulated rate binding and an intercepted
302; all outbound requests are handled by an injected service with no network
passthrough. No real provider is contacted.

The RPC reply is a bounded flat JSON string containing framing only. The outer
Worker parses it with the existing duplicate-key-rejecting parser and validates
it again. This avoids treating Cloudflare's RPC object disposal metadata as a
framing field and preserves the exact-key validator without weakening it.

Profile weights are server constants: economy 1, balanced 2, quality 4. These are
relative usage weights, not pricing or token billing. The positive integer daily
ceiling is future server configuration. Missing, malformed and zero ceilings
deny execution. Provider usage metadata never settles reservations.

The frequency limiter is checked at the outer admission boundary and again by
the coordinator's C1B guard. These are two conservative frequency checks per
successful POST, using a fixed application key; neither grants budget or slot
authority. GET capabilities may check outer readiness but never reserve budget
or invoke the provider. Capabilities remain advisory.

## Ownership and failure model

Reservation units count against their original UTC day immediately. A denied
concurrent request releases only its own unused reservation. Once dispatched,
network failures, HTTP errors, parser/framing errors and timeouts consume units.
Caller completion does not release active work. C1B registers the underlying
fetch/body drain; only that termination path marks the slot ready for finalization.
Finalization and slot clearance share one SQL transaction and reject duplicates.
Old-day finalization never credits a new day's bucket.

There is no queue, lease expiry, automatic retry, alarm-based refund or startup
reset. A new coordinator instance reads the same occupied slot. Even if the old
runtime's operation could continue, the new instance cannot start a second one.
If that old operation terminates and its continuation runs, it finalizes the
same durable reservation. If a crash loses the continuation, the persistent
dispatch intent/slot remains fenced. A crash between intent persistence and
network dispatch can conservatively hold capacity and units although no charge
occurred. This implementation does not claim automatic crash recovery or exact
remote provider termination. Recovery from uncertain crash state requires a
separately reviewed operator procedure; simply restarting or advancing UTC day
does not clear it. No runtime reset is interpreted as proof of remote termination.
If the original dispatch closure resumes and knows it never invoked fetch (for
example, cancellation while awaiting persistence), it may cancel only a
`dispatching` intent and release that unused reservation. A `started` reservation
cannot take that transition.

Offline tests execute actual SQLite queries using Node's built-in SQLite API,
reconstruct coordinator instances over the same database, and route independent
outer contexts through a namespace harness. Only routing is held in a test Map;
budget/concurrency authority lives in SQLite. Tests deliberately retain old
pending work while constructing a new instance. This is evidence for the
persistent fence, not a simulation of all Cloudflare failure modes.

## Deferred deployment values and owner gates

The account-wide numeric rate namespace cannot be certified unique offline.
No existing repository rate namespace is configured. The numeric value is
intentionally omitted rather than guessing an account identifier. Before any
future deployment, inspect the account and add a unique `ratelimits` entry named
`COACH_REAL_RATE_LIMITER`, with an owner-approved frequency policy. Missing binding
fails closed. The SQLite `new_sqlite_classes` migration is prepared locally only.

First deployment/migration, remote rate binding activation, secret provisioning,
enable=true, a nonzero live ceiling, and the first paid request each remain behind
new explicit owner authorization. Do not use the fake Worker configuration for
that deployment. No live model availability check has been performed.

## Platform references

- [SQLite storage, synchronous transactions and sync](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object lifecycle and pending I/O](https://developers.cloudflare.com/durable-objects/api/state/)
- [Rate Limiting API accuracy and namespace identity](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

The implementation uses the documented transactional storage contract. It does
not rely on `waitUntil` as a Durable Object lifetime guarantee; Cloudflare documents
that `waitUntil` has no effect there. Its persistent fence also survives uncertain
runtime termination. Rate-limit counters are eventually consistent and are not
an accounting system.
# C1E public-path restriction

The undeployed real-staging public path additionally requires the exact server
value `COACH_REAL_PROVIDER_PUBLIC_ENABLED="true"`. This authority is absent in
committed config, independent of real-provider enable/secret/rate/budget, and may
only be enabled in a separately reviewed later phase. Client inputs cannot set it.
Fake staging and browser request/response schemas are unchanged. The first future
paid attempt must use the separate internal persistent one-shot operator contract;
the C1F undeployed Access transport is documented in `PRELIVE_ACCESS_OPERATOR.md`.
See the C1E section of `PRELIVE_RECOVERY_AND_LIVE_PLAN.md` for the full owner-gated
sequence and terminal CONSUMED semantics. All current provider tests are mocked.
