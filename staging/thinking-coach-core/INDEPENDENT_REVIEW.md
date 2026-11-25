# U3-01A Independent Review

Reviewer: independent agent `u301a_independent_review` (not the implementation author).
Date: 2026-11-25. Base: `dcf2cf3333c9c7282d88dfa3d89da647baae2fb0`.

**INDEPENDENT_REVIEW=PASS**

**NEW_P1_P2=0 unresolved.** One P2 was found during development, fixed, retested and preserved
in the review history. This is not a claim that no defect was ever found.

## Independently checked

- Reran core and mutation suites: 42 PASS / 0 FAIL / 0 skipped, including 11 detected faults.
- Independently exercised A's full three-defense set and exploration/undo; B's recapture
  without move-quality judgment; C's atomic illegal-candidate rejection; D's scoped mate.
- Checked source, branch, Session, history and frozen snapshot isolation; stale, out-of-order,
  duplicate and cross-instance tickets are rejected, even with equal public identity fields.
- Checked that hypotheses remain unproved and `teaching()` contains no answer data.
  README clearly separates this default projection from explicit diagnostic APIs.
- Independently checked the original 27-suite baseline log and SHA-256: 667 PASS / 0 FAIL /
  0 skipped. The reviewer inspected this run's evidence; did not claim another 667 execution.
- Independently compared the corrected `raw-site` against the preserved canonical production
  manifest: full 74-file inventory correct, 70 Runtime files equal by bytes/SHA-256,
  excluded-file leaks = 0. Did not normalize LF or request production URLs.
- Cache check: `356f6af929`; existing tracked product files have no diff.
- All eight implementation/fixture/test/README files in external `candidate-files.json`
  matched the reviewed bytes. Additional closeout reports do not change executable code.

## Findings and corrections

1. **P2, corrected:** Proxy reflection could reenter a lifecycle operation during data
   copying. A reset could lead to accepting an old verification result; invalidation could
   be followed by adding a candidate. Both are the same root cause. Data now rejects Proxy
   before reflection; settlement also rechecks generation/branch/node after input validation.
   Root/nested Proxy tests and the corresponding mutant cover the correction.
2. **Boundary improvements:** at the 128-node cap, existing children remain revisit-able;
   next-move recapture checks at terminal positions return `NOT_APPLICABLE_TERMINAL`.
3. **Test maintenance:** the first cross-Session mutation control used differing generated
   IDs, allowing another fence to hide the targeted weakness. It now aligns IDs and verifies
   their equality before testing private ticket ownership. Original 38 PASS / 1 FAIL remains
   preserved, followed by successful fault detection.
4. **Build environment:** the first LICENSE comparison found CRLF archive-export bytes.
   The failure, archive, source, artifact and log remain preserved. Only the new raw-Git-Blob
   source/build passed the canonical byte comparison; there was no blanket LF normalization.

## Review limits

Node-only core PoC; no UI, AI Worker, cloud/LLM, persistence or browser acceptance claim.
Complete history means legal replay from a caller-declared root, not authenticated real-world
history or full reachability. Existing application repetition rules remain the boundary.
Diagnostic APIs contain move data and require deliberate use by any future UI adapter.

Test sets overlap and are not summed as independent coverage. Local PASS is not GitHub CI PASS.
PR #21 release status and Issue #22 remain unchanged. No Issue #22 HTTP retry was performed.

The reviewer did not modify files, create commits or operate deployments. The main workflow
separately verified the other 21 worktrees and 148 Snapshot files against the initial manifest;
they remained unchanged.
