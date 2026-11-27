# U3-01B-0 Browser Compatibility & Security Gate

Base: `05137bd0dc9e4eb14048b8a848c94b31662f41e5`.
This is an excluded staging PoC, with no chessboard UI or production entrypoint.
The original U3-01A Node files and all production files remain unchanged.

## Architecture and compatibility

`build-browser.mjs` deterministically derives `browser-coach.mjs` from the existing
identity/rules/core and this directory's protocol template/SHA implementation.
The generated module exports **only** `createBrowserCoach` and `fingerprintJSON`.
The original core, data copier and rules adapters are module-private. There is no
runtime eval, module rewriting, import map, Node shim, or public object-based factory.
Run `node staging/thinking-coach-browser/build-browser.mjs --check` to reject build drift.
The generated header hashes LF-normalized **build inputs**, not production asset bytes.
Production integrity checks always use raw Git Blob bytes without LF conversion.

| Dependency | Browser treatment |
| --- | --- |
| `node:crypto` synchronous SHA-256 | Synchronous UTF-8 SHA-256 in `sha256.mjs`; Node crypto, Chrome Web Crypto and fixed known vectors cross-check it |
| `node:util.types.isProxy` | No browser equivalent claimed. External objects never enter the generated core; only primitive JSON text is accepted |
| Node ES modules | Node build/test helpers remain staging-only; the browser entry's entire loaded graph contains no Node imports |
| `game.js`, `custom-position-play.js` | Unchanged existing ES modules; transitive puzzle/editor/record validation dependencies load in Chrome without storage/Worker calls |
| Session methods / fingerprints | Synchronous; original stable serialization, source/history fields, legal rules and evidence semantics retained |

SHA-256 implements [FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final).
Native [`SubtleCrypto.digest`](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#SubtleCrypto-method-digest)
returns a Promise, so it is a differential test oracle rather than a replacement
that silently makes the Session API asynchronous. This implementation is tested,
not a claim of cryptographic certification or a general cryptography library.

## Public wire contract

```js
import { createBrowserCoach } from './browser-coach.mjs';
// Obtain sourceText from a trusted serializer or an existing JSON transport.
// Never JSON.stringify an untrusted object merely to get through this boundary.
const coach = createBrowserCoach(sourceText); // exactly {sessionId, source}
const question = JSON.parse(coach.teaching());
coach.dispatch('{"op":"observe"}');
const stateText = coach.dispatch(candidateCommandText); // {op:"addCandidate",move:{from,to}}
coach.destroy(); // idempotent; drops private Session and ticket references
```

The source schema is exactly the existing U3-01A source schema (10x9 board,
sourceId, sourceSessionId, sideToMove, history). Pieces permit only `type` and `side`.
Known/partial history includes an exact root board/side and at most 1024 legal moves.
The browser does not accept host Root, Session, board or record references.
Return values are JSON **strings**, so parsing an output cannot create an internal reference.
`teaching()` returns only stage/question/uncertainty; default output never contains answers.

`dispatch` permits only these exact command envelopes:

| Commands | Fields besides `op` |
| --- | --- |
| snapshot, observe, coverage, nodeFacts, undo, reset, invalidate, reflect, teaching, compare, checkNoImmediateRecapture, searchEvidence | none |
| addCandidate, play | move |
| selectBranch, resetBranch | id |
| addHypothesis | text |
| beginVerification | none |
| settleVerification | ticket, result |

`beginVerification` returns a random opaque UUID handle and identity **data**.
The original core ticket object stays in the closure. Settling requires the matching
current handle, then passes the retained original ticket to the original core.
The result has exactly `identity` and `legalReplies`, and the exact legal reply set
is re-derived before any canonical evidence is emitted. Incoming evidence labels
are never trusted. A foreign/stale handle cannot consume a newer valid ticket.
Same-board/same-sessionId instances still have different handles; histories and
source Sessions participate in the unchanged SHA-256 identities.

The explicit diagnostic commands (snapshot/coverage/compare/etc.) contain boards,
child moves or enumerated replies. They are not default teaching view models and
must not be automatically rendered by a future UI. No such UI is included here.

## Security boundary and deliberate differences

Every text entry checks `typeof input === 'string'` before length, conversion,
reflection, JSON parsing or hashing. Proxy, revoked Proxy, getter-bearing object,
cyclic object, boxed String, functions and arrays are rejected without invoking
their traps/getters/toJSON/toString. Do not claim these objects were inspected for safety.

The bounded parser uses no reviver or caller callback. Its primitive token decoding
uses the native [JSON semantics](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse).
Limits are 262144 UTF-8 bytes (and code units), depth 16 with root at depth 0,
and 30000 parsed values. It additionally rejects duplicate decoded keys, nonfinite
numbers, trailing syntax, and `__proto__`, `prototype`, `constructor` keys at any depth.
Source, piece, move, command, result and identity fields are checked against their
schemas or exact expected identity. These wire restrictions are intentionally
stricter than the original Node object API; data outside them is rejected, not coerced.

Malformed JSON or command envelopes are rejected **before** entering the Session;
they do not consume a verification ticket. Once a well-formed settle envelope matches
the current handle, a malformed/incorrect **result** consumes that one-shot ticket,
matching the original core. Unknown operations do not fall through to arbitrary methods.

This protects against untrusted **input data** in a trusted JavaScript realm.
It is not a sandbox for hostile same-origin scripts, modified browser intrinsics,
replaced imported modules or a compromised `crypto.randomUUID`. HTTPS/localhost
and modern `TextEncoder`, `structuredClone`, ES modules and Web Crypto randomness
are required. No unsafe fallback exists if randomness is unavailable; ticket creation
fails before changing the core. Tickets are in-process lifecycle fences, not network authentication.

Internal `JSON.stringify`, `structuredClone`, descriptor inspection and stable sorting
operate only on privately parsed data or trusted engine-generated data. The browser
build removes the Node-only Proxy check **only** on this closed private path. It never
replaces it with a fake browser Proxy detector. The original Node P2 fix remains intact.

Evidence remains CANONICAL_FACT / ENGINE_SEARCH_EVIDENCE / UNPROVEN_HYPOTHESIS.
No search runs; legal alternatives or sacrifices are not marked wrong. Incomplete
history never proves a complete-game verdict, and arbitrary hypotheses stay unproved.

## Verification and scope

```text
node staging/thinking-coach-browser/build-browser.mjs --check
node --test staging/thinking-coach-browser/browser-node-test.mjs
node staging/thinking-coach-browser/browser-test.mjs ABSOLUTE_EXTERNAL_OUTPUT_DIR
```

Set `PLAYWRIGHT_MODULE` to an existing Playwright entry when it is not installed in
the local module search path. The runner uses real `channel: 'chrome'`, fresh contexts,
synthetic fixtures, a loopback-only server and network restriction. It does not open
the production site, Issue #22 paths, or a user's browser profile. Each output directory
must be new; initial/failing evidence is never overwritten. Mutants exist only in HTTP
responses in memory; an import/initialization failure cannot count as effective detection.

See TEST_REPORT.md and INDEPENDENT_REVIEW.md. No local result is GitHub CI PASS.
Real devices, assistive technologies, human UAT, real BFCache, UI/Worker integration,
long-term heap profiling and learning outcomes remain untested. Bounded synchronous
history replay may be costly; future UI scheduling needs its own acceptance gate.
PR #21 remains BLOCKED_PRODUCTION_ACCEPTANCE; Issue #22 remains OPEN and unprobed.
No merge, deployment, rollback or U3-01B-1 is authorized by this work.
