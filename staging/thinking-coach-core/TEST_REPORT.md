# U3-01A Core PoC — Test Report

Base SHA: `dcf2cf3333c9c7282d88dfa3d89da647baae2fb0`.
Validation date: 2026-11-25 (Asia/Taipei). Node: v22.23.2.

This is a local core-only verification, not production acceptance or GitHub CI PASS.
No AI Worker, cloud provider, LLM, browser UI, deployment, HTTP exclusion retry or storage
write was used by this PoC. Existing PR #21 release status is unchanged; Issue #22 remains open.

## Results

| Gate | Result |
| --- | --- |
| Core and mutation suite | 42 PASS / 0 FAIL / 0 skipped |
| Core functional/boundary cases | 31 cases, included in the 42 above |
| In-memory mutation controls | 11 detected / 11, included in the 42 above |
| Original Node baseline | 27 original files, 667 PASS / 0 FAIL / 0 skipped |
| Fixed A/B/C/D positions | All expected legality, reply counts, terminal outcomes and fingerprints pass |
| Source and branch isolation | PASS; immutable snapshots, source object/reference checks, independent candidate trees |
| Session/revision fences | PASS; cross-instance identical public IDs, branch changes, undo/reset, out-of-order, duplicate and invalidated results rejected |
| Evidence | PASS; incomplete history stays unproved, hypotheses cannot promote themselves, no search result fabricated |
| Default teaching projection | PASS; fixed question/uncertainty fields only, no answer payload |
| Real local Jekyll output | 74 files; all 70 Runtime assets equal Base Git blobs by raw bytes/SHA-256 |
| PoC exclusion | No staging/PoC/test/backend leakage in local Pages artifact |
| Existing tracked source | All 255 Base tracked files unchanged, including original staging content |
| Cache | `356f6af929`; existing readonly cache check passes |

The mutation suite reuses contract assertions; its cases are not additional independent
teaching scenarios. Independent reviewer probes and repeated local runs are not added to
these totals. The original 667 are not claimed to cover the new feature.

## Reproduce

```sh
node --test --test-reporter=tap --test-concurrency=1 staging/thinking-coach-core/core-test.mjs staging/thinking-coach-core/negative-controls-test.mjs
```

The baseline uses exactly the previous post-merge list:

```sh
node --test --test-reporter=tap --test-concurrency=1 pointer-safety-test.mjs new-game-confirmation-test.mjs player-side-selection-test.mjs quick-start-content-test.mjs mobile-review-ui-test.mjs game-record-test.mjs game-record-store-test.mjs game-review-lifecycle-test.mjs game-review-test.mjs game-review-continuation-test.mjs game-review-continuation-ui-test.mjs game-export-test.mjs game-import-test.mjs game-transfer-test.mjs game-transfer-worker-test.mjs puzzle-editor-test.mjs puzzle-recorder-test.mjs puzzle-practice-test.mjs puzzle-ui-lifecycle-test.mjs puzzle-photo-calibration-test.mjs puzzle-photo-test.mjs custom-game-root-test.mjs custom-position-play-test.mjs board-appearance-test.mjs terminal-overlay-focus-test.mjs terminal-presentation-test.mjs piece-hit-recovery-test.mjs
```

Full TAP output and structured run metadata are preserved outside the worktree in the Owner's
`chess-u3-01a-20261125` evidence directory (not public download URLs):

| Evidence | SHA-256 |
| --- | --- |
| `core-final.log` | `a13fea63bcb9c866bda0446e8ee4dae81b46122913c994f465920d2c3ad7dd12` |
| `baseline-final.log` | `473c5290829d1bba223a565b91a4f791b8d2b2d989c7de71e7500903b558a6be` |

`core-final.json` and `baseline-final.json` retain exact arguments, start/end UTC times,
Node version, process exit status and output hashes. `fixtures.json` preserves all 90 cells,
expected moves/outcomes and source fingerprints; `core-test.mjs` verifies them without
regenerating the expected A reply set from the implementation under test.

## Fixed positions and branch behavior

- A: exactly three different legal defenses to the chosen check, including block, king escape
  and capture of the checking rook. Each can be tried, continued, undone and revisited; coverage
  is 3 explored / 0 unexplored only after each immediate reply was actually played. It does not
  become a forced-win proof.
- B: 20 legal replies after the learner's capture. The recapture refutes only the narrow
  no-immediate-recapture hypothesis, not the quality of the learner's candidate. An alternative
  legal candidate remains available; comparing branches reports facts without ranking.
- C: the candidate exposing facing kings is rejected without changing board, branch list,
  cursor or revision. The alternative rook move remains legal.
- D: board checkmate is established; subsequent moves are rejected. With unknown source
  history this is position-only evidence. A next-move recapture hypothesis is not applicable.

Additional boundaries cover complete-history replay and mismatch rejection, different
histories ending on the same board, different source Sessions, partial/unknown repetition
limits, strict data-only inputs, terminal sessions, bounded tree capacity, existing-node
revisits at capacity and root/nested reentrant input attacks.

## Negative controls

| Injected defect | Behavioral failure required |
| --- | --- |
| Drop one legal defense | Fixed A count/set assertion |
| Bypass candidate legality | C illegal-candidate rejection/atomicity assertion |
| Mutate caller's board | Source-content preservation assertion |
| Accept another Session's ticket | Identical public identity still rejected by private instance ownership |
| Keep an older pending request | Out-of-order result rejection assertion |
| Promote hypothesis to fact/proved | Evidence kind and proved=false assertions |
| Add answer to default output | Strict teaching projection/no-answer assertions |
| Write localStorage | Instrumented forbidden side-effect trap |
| Claim incomplete history is verified | Missing-history evidence/scope assertions |
| Accept incomplete external reply set | Omission rejection assertion |
| Allow reentrant Proxy data | Proxy must be rejected before invoking lifecycle callback |

All mutations modify in-memory copies, never real source or storage. Every control checks
the original implementation first. A mutant must trigger its behavioral assertion or the
specific storage trap; an import, syntax, setup or unrelated runtime failure is not credited.

## Preserved first failures and remediation

1. The first expanded run had 38 PASS / 1 negative-control FAIL. The cross-Session test had
   different generated branch IDs, so another identity check masked the intended weakened
   ticket-ownership mutation. The test now aligns both Sessions' IDs/revisions exactly and
   verifies that equality before exercising the private instance fence. The mutant is now
   detected. The original output is retained as `initial-core-38-pass-1-control-fail.log`.
2. Independent review reproduced one P2 in the new PoC: a Proxy callback during input copying
   could reset/invalidate a Session after its initial guard, accepting a stale result or adding
   a candidate to an invalid Session. Proxy data is now rejected before reflective operations,
   and result settlement has a final generation check. Root/nested Proxy tests and a mutant
   cover the correction. The before-fix probe is preserved in `review-initial-findings.json`.
   This was one root cause, not separate duplicate findings; no existing production source
   was affected.
3. The first local Jekyll artifact excluded PoC files, but failed the raw Git byte gate:
   `git archive` exported LICENSE as 1,133-byte CRLF content rather than the approved
   1,111-byte Git blob. Original archive, source directory, artifact and build log are preserved.
   The corrected source was generated file-by-file with binary `git show` output into a new
   directory; no all-file LF conversion was used. The new real Jekyll build passes all 70 raw
   Runtime comparisons. `artifact-initial-failure.json` and `artifact-integrity.json` retain
   both outcomes. These are local builds, not repeated deployments.

## Artifact and scope evidence

`artifact-integrity.json` records every built path, each Runtime byte count/hash, the fixed
Base, zero excluded leaks and the readonly cache result. Jekyll used the existing configured
environment and untouched `_config.yml`. It emitted the existing non-fatal Faraday retry and
unauthenticated GitHub metadata warnings; these do not justify ignoring content differences.
No request was sent to the production site or Issue #22 excluded URLs.

All implementation, tests, fixtures and reports stay in this previously absent subdirectory.
No production import or entry point references it. Other-worktree/Snapshot protection manifests
are preserved separately. The final independent verdict is in `INDEPENDENT_REVIEW.md`.

## Remaining limits

- Node-only PoC: no UI/browser acceptance, cloud/LLM integration, AI search, automatic solution,
  learning-effectiveness evaluation or permanent progress storage.
- Complete history is only from a declared root, not authenticated external history; missing
  history never supplies a full-game verdict. Existing application rules are not an exhaustive
  tournament ruleset.
- Diagnostic APIs contain moves and replies; only `teaching()` is the default non-answer
  projection. Future UI integration needs separate review and authorization.
- Real devices, screen readers, human UAT and real BFCache remain untested.
- The four historical BASELINE_FAIL records, prior HTTP503, CRLF verifier failures and
  environment/timing exceptions remain historical evidence. This PoC does not change PR #21's
  `BLOCKED_PRODUCTION_ACCEPTANCE` or close Issue #22.
- Local Node/Jekyll PASS is not GitHub CI PASS. No U3-01B, merge, deployment or rollback is included.
