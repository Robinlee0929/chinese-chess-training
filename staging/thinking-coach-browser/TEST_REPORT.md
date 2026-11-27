# U3-01B-0 Test Report

Base: `05137bd0dc9e4eb14048b8a848c94b31662f41e5`.
Evidence: `C:/Users/Robin/AppData/Local/Temp/chess-u3-01b0-20261126`.
Results below are local, not GitHub CI PASS. Collections overlap and are not summed.

| Set | Result |
| --- | --- |
| Original U3-01A core | 42 PASS / 0 FAIL / 0 skipped |
| Original negative controls | 11/11 effective, included in 42 |
| Original 27 Node suites | 667 PASS / 0 FAIL / 0 skipped |
| New Node browser-contract tests | 2 PASS / 0 FAIL: SHA differential and shared behavioral group |
| Full Chrome 158.0.8127.38 | 29 positive checks PASS |
| New Chrome negative controls | 14/14 effective; all modules successfully imported first |
| Browser isolation | 15 fresh contexts, loopback only, no external requests |

The shared behavior group runs in both Node and Chrome, not as independent coverage
counts. Chrome includes 70 SHA vectors compared to both Node crypto and native Web Crypto:
empty, abc, long standard input, million-a, padding/block boundaries, Chinese, emoji,
surrogates, four source fingerprints and 50 deterministic Unicode strings.
Initial Chrome evidence (26 positive / 13 mutants) is retained; final evidence adds
history replay, malformed envelope/result semantics and the fingerprint mutation.

Core TAP SHA-256: `5a6d265ecd0cbac3088fee138d2745ef23c4d3d6b75e6bb5a408a2a0626cce98`.
Baseline TAP SHA-256: `667650548fb232d9b070b7ee4ff21edabecd9798a86ac67417fb02bce106fdfa`.
Browser-node TAP SHA-256: `a0cfa7d324b29842209115874dd9cb4deed9419b004e1dba7b838bc46e18d9b7`.
Generated entry SHA-256: `a778642b7a9ad0cd8cfcd7094305495912beb567a0ec474d5cfa6606e1419f72`.

## Behavioral coverage

- A/B/C/D complete boards and fixed source hashes retained. All legal replies, Node
  initial/candidate state, node facts and coverage match in Chrome. A's literal three
  defenses and B's recapture/alternative remain valid. C explicitly requires ILLEGAL_MOVE
  for the real fixture `illegal` and unchanged state. D remains position-only checkmate.
- Two candidates, exploration/undo/reset/navigation, 60 create/reset/invalidate/destroy
  cycles, branch/node/revision identity, stale/out-of-order/duplicate/cross-instance
  tickets and malformed result one-shot consumption pass.
- Same board with different source Session/history has distinct identities. Partial
  and complete legal history replay matches original Node snapshots and evidence scopes.
- Caller-owned data is not mutated; output parsing yields detached data. Proxy/getter/
  toJSON/revoked Proxy/cyclic inputs reach no callback at create/dispatch/fingerprint.
- Strict JSON size/depth/node bounds, duplicate/escaped duplicate keys, schema fields,
  forbidden keys, malformed syntax and nonfinite values are rejected.
- Default teaching has exactly stage/question/uncertainty. Hypotheses do not become
  proven facts; search remains unavailable. localStorage sentinel is unchanged; trapped
  storage and IndexedDB operations remain zero in the positive run.

## New negative controls

1. Corrupt identity fingerprint.
2. Reflect/stringify untrusted input before primitive check (Proxy callback/reentry).
3. Accept duplicate JSON keys.
4. Disable nesting limit.
5. Disable input size limit.
6. Remove piece field whitelist.
7. Reuse one handle across Sessions.
8. Accept results after reset.
9. Accept a duplicate settled result.
10. Accept an incomplete defense set.
11. Accept a literal illegal move.
12. Leak a candidate in default teaching.
13. Promote a hypothesis to a proved fact.
14. Write localStorage during Session creation.

Each exact mutation site must match once. Import occurs outside the behavioral catch.
Only the expected OracleFailure counts; storage additionally requires an observed
write attempt. The positive oracle runs before mutations. Syntax/import failures are
errors, never successful negative controls. Mutations never alter tracked sources.

## Historical evidence and limitations

Real local Jekyll validation produced 74 files: all 70 Runtime Buffers equal Base
raw Git Blobs, staging absent, Cache `356f6af929`. `artifact.json` records the first
10-file source inventory. After adding INDEPENDENT_REVIEW.md, a separate final
11-file source/build is saved under `final-artifact/`; the initial evidence is not
overwritten. This is a local build, not a deployment or a GitHub CI result.

The first shell one-line Node import smoke had PowerShell quoting SyntaxError before
module evaluation; it is not a product failure or valid negative-control result.
An early C helper referenced a nonexistent expected field; before final acceptance it
was replaced with the literal fixture move plus exact ILLEGAL_MOVE and state oracle.
Original output/evidence is retained externally. Reviewer probe generator's initial
undefined-value mistake is separately retained in its historical-probe-exception.json.

The four old BASELINE_FAIL were fixed by PR #23; their 659 PASS / 4 FAIL history is
not erased. Prior U3-01A Proxy P2, initial negative-control failure, CRLF comparisons,
HTTP 503 and environment/timing exceptions remain historical. PR #21 stays BLOCKED;
Issue #22 stays OPEN. No HTTP exclusion retries occur here.

See README for trusted-realm boundary, stricter wire limits and untested UI/real-device/
screen-reader/UAT/BFCache/heap/learning-effectiveness limitations. Hash differential
tests are strong regression evidence, not cryptographic certification or a formal proof.
