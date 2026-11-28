# U3-01B-2 test and evidence report

Base: `67ed4f5ece5f1c9a47bfd38b5507a41afd560875`.
Date: 2026-11-27 (Asia/Taipei). This is local verification, not GitHub CI PASS.

## Environment and results

Windows, Node 22.23.2, full Chrome 158.0.8127.38, isolated Playwright contexts,
synthetic fixtures, loopback-only requests, no real student or saved-game data.
Browser plugin not available; the installed Playwright package drives full Chrome.
Each context traps storage/IDB/Worker writes and preserves a synthetic sentinel.
Page title, 90 cells, initialization, console, overlay absence, overflow and real
interactions are checked. Screenshots were inspected at desktop and mobile sizes.

| Suite | Result | Scope |
| --- | --- | --- |
| New guidance Node | 29 PASS / 0 FAIL / 0 skipped | Context records, evidence, races, limits |
| New guidance Chrome | 30 PASS | Five viewports, A/B/C/D, interaction and records |
| New fault controls | 21/21 effective | Behavior assertions after successful initialization |
| Existing sandbox model | 16 PASS | Unchanged original suite |
| Existing sandbox Chrome | 32 PASS; 11/11 faults effective | Includes focus fallback and reset race |
| U3-01A core | 42 PASS | Includes its original 11 negative controls |
| Original Node baseline | 667 PASS / 0 FAIL / 0 skipped | All 27 suites retained |
| Browser core Node groups | 2 PASS | Original generator/API groups |
| Browser core Chrome | 29 PASS; 14/14 faults effective | Includes 70 SHA-256 parity vectors |
| Browser generator | PASS | `build-browser.mjs --check` |
| Full AST graph | PASS | Acorn 8.15.0; 11 modules / 16 edges; no Node runtime dependency |
| Scanner controls | PASS | 7 positive, 24 dependency/policy faults, 1 intentional syntax rejection |
| Path policy | PASS | 15 positive, 10 invalid paths rejected, 8 behavioral mutations |
| Real Jekyll safe build | PASS | 74 expected files, all staging excluded |
| Runtime integrity | PASS | 70 raw-byte/SHA-256 matches with Base and saved approved artifact |
| Cache | `356f6af929` | Unchanged |

These sets overlap and are not summed into an independent coverage total.
The final UI fixes were followed by fresh guidance 29/30/21 and sandbox Chrome
32/11 runs. The earlier 42/667/browser-core results remain valid: their code,
dependencies and tests were not changed. No test was deleted, skipped or weakened.

## Functional checks

Five sizes: 320x568, 375x812, 390x844, 844x390 and 1440x1000. Mouse, simulated touch,
keyboard hints/board controls, Escape and reset confirmation/cancellation are covered.

Children can record observation, two candidate reasons, different defense forecasts,
three plies of calculation, a mismatched expectation and their own correction.
Branch/node/stage changes preserve distinct records; reset/reload/fixture changes
clear them. Legal alternatives and sacrifices remain usable without correctness
scores. Immediate replies and recaptures are limited facts, not full-line proofs.
Default/hidden markup and accessibility snapshots contain no future answer data.
User-entered markup is rendered as text, never executable HTML.

Prediction checking does not move the board. Cross-session/stale inputs fail without
mutating valid state; edits/navigation/reset/destroy invalidate delayed results.
Both verification types reject mixed concurrent work. Input remains bound to its
context while checking. Optional targets remain adjustable with unsaved text.
At 16 archived revisions, later current drafts survive branch navigation and reset
cancellation; confirmation clears them. The 1024-context capacity path is exercised
with an in-memory test variant using capacity 1, explicitly reported as a bounded
branch test rather than a 1024-record performance/stress claim.

## New fault controls

1. Collapse branch/node record identity.
2. Collapse stage identity.
3. Accept a foreign session write.
4. Accept a stale version write.
5. Retain records across reset.
6. Upgrade child hypothesis to canonical fact.
7. Claim a full continuation is proven.
8. Accept an illegal predicted move.
9. Omit an immediate recapture.
10. Promote a stale prediction result.
11. Drop declared source history during verification.
12. Put an untried answer in hidden guidance.
13. Grade arbitrary free text.
14. Write guidance to persistent storage.
15. Lose a draft on canceled reset.
16. Retain stale branch-button closures after saving.
17. Remove the check=yes option through malformed markup.
18. Stop controlling expectation values by context.
19. Lose text typed during asynchronous checking.
20. Lose a dirty challenge-selector change during rerender.
21. Freeze navigation/reset at the revision limit.

Mutation import and factory initialization are outside the detection catch. Only
the intended behavioral assertion failure counts. Two old draft faults disable both
redundant draft protections to reproduce their failure; this is disclosed, not
counted as extra independent coverage. Mutants exist only in the test server's memory.

## Independent findings and retained failures

Independent review found seven concrete P2 reproducers during development. All
were fixed and independently retested: R1 canceled-reset draft loss; R2 stale
button closures; R3 missing yes option; R4 expectation ownership; R5 typing during
an async check; R6 dirty challenge selection; R7 revision-limit navigation freeze.
R1/R5 overlap in draft ownership and are not seven independent risk categories.
Original probes, failures, screenshots and source preimages remain outside Git.
See GUIDANCE_INDEPENDENT_REVIEW.md for the final independent disposition.

Historical evidence remains unchanged: the original 659 PASS / 4 BASELINE_FAIL
(obsolete player-side text plus three VM fixture failures) precede PR #23's
667 PASS repair. Earlier Proxy reentry P2, focus/reset race failures, timing/probe
exceptions, CRLF manifest failure, import-string/path scanner false positives and
HTTP 503 records are retained. Later success does not erase these failures.

## Evidence index

Owner-local evidence root (not a public download):
`C:/Users/Robin/AppData/Local/Temp/chess-u3-01b2-20261127/`.

- `guidance-final-29.log`, `guidance-browser-03/results.json` and screenshots.
- `legacy-browser-final-02/results.json`; `model-final.log`.
- `core.json`/`.log`, `baseline.json`/`.log`, `browser-node.json`/`.log`,
  `browser-core/results.json`, `generator.json`/`.log`.
- `AST_GATE.json`, `sandbox-runtime-graph.json`, `scanner-tests-recovery.json`,
  `path-policy-tests.json`, `root-entry-injection.json`.
- `source-manifest.json`, `jekyll-build.log`, `artifact-integrity.json`:
  verified raw Git Base export plus staging-only overlay; saved approved Pages
  ZIP SHA-256 `8b141d80c5a8f6a9ecbbbb17d2f65b2480c8d89c230d10a3ba9527c122f630c0`.
- `protection-before.json` and subsequent checks; final source/evidence hash index.

Independent evidence root:
`C:/Users/Robin/AppData/Local/Temp/chess-u3-01b2-review-20261127/`.
It contains original R1-R7 probes, independent fixed probes, final Node logs,
`guidance-browser-independent-final/results.json` and unchanged code hashes.

The verifier uses Buffer equality and SHA-256; no LF/CRLF normalization. LICENSE
matches its Git blob and approved artifact. Generated Primer CSS and document HTML
match the approved Base artifact at the same build revision. A single-byte mutation
in main.js, LICENSE or an image is detected. Jekyll's optional GitHub metadata/auth
and faraday-retry notices are preserved; they did not alter the compared output.

## Unmeasured limits

No real-device testing, screen-reader testing, human UAT, real BFCache restoration,
long-term heap/performance measurement or teaching-outcome study has been performed.
No claim of educational effectiveness is made. This is a trusted-realm prototype,
not a defense against hostile same-origin scripts. It is not a production release.
PR #21 remains `BLOCKED_PRODUCTION_ACCEPTANCE`; Issue #22 stays OPEN. Its HTTP
paths were not retried. No merge, deployment, rollback or U3-01C work is authorized.
