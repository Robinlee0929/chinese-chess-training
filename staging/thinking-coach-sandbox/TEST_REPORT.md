# U3-01B-1 test evidence

Base: `a77d1a038e3d8ee21480ef09ab20ba4a1ca62ad9`.
Environment: Node v22.23.2, full Chrome 158.0.8127.38, Windows.
Browser skill was unavailable; the existing Playwright installation drives isolated
Chrome contexts with synthetic data and loopback-only networking.

Evidence root: `C:/Users/Robin/AppData/Local/Temp/chess-u3-01b1-20261127`.
Independent evidence: `C:/Users/Robin/AppData/Local/Temp/chess-u3-01b1-review-20261127`.
These are external evidence locations, not runtime imports or published content.

| Set | Result | Evidence |
| --- | --- | --- |
| New model | 16 PASS / 0 FAIL / 0 skipped | model-fixed.log |
| New UI scenarios | 32 PASS | browser-final/results.json |
| New UI/security mutations | 11/11 effective | browser-final/results.json |
| Original core | 42 PASS / 0 FAIL / 0 skipped, includes original 11 negatives | core.json / core.log |
| Existing baseline | 27 suites, 667 PASS / 0 FAIL / 0 skipped | baseline.json / baseline.log |
| Browser-core Node groups | 2 PASS | browser-node.json |
| Original Chrome safety | 29 PASS, 14/14 negatives effective | prior-chrome/results.json |
| SHA-256 parity | 70 Node / pure JS / Chrome WebCrypto vectors | prior-chrome/results.json |
| Browser-core generator | --check PASS | generator.json |
| AST runtime dependency graph | PASS; 9 modules / 13 static edges; no Node runtime imports | runtime-graph-final.json |
| Cache | 356f6af929, unchanged | cache.log |

The 32 UI scenarios comprise 20 fixture/viewport cases, five keyboard/alternative
cases, full A defense exploration, stale check/switch/reset, and five focus/native
reset-race cases. Viewports: 320×568, 375×812, 390×844, 844×390, 1440×1000.
The first four use simulated touch for board movement; desktop uses the mouse.
Keyboard navigation, focus and Escape are tested at all five sizes.

Checks cover page identity, meaningful content, load errors, console errors,
horizontal overflow, actual board states, default hidden/visible DOM and accessibility
snapshots, explicit fact disclosure and its removal, two candidates, legal alternatives,
sacrifices, all three A defenses, retained visited nodes, reset/cancel, text-as-data,
storage sentinels and forbidden storage/Worker calls. No network request loads test
answers (`fixtures.json` or `test-data.mjs`). All requests stay on loopback.

## Negative controls

All mutations are served only in memory in separate contexts. The application and
module must initialize successfully before an assertion failure can count.

| Mutation | Behavioral oracle |
| --- | --- |
| Hidden answer DOM | Empty undisclosed fact DOM / default DOM audit |
| Answer in accessible name | DOM and accessibility snapshot audit |
| Missing stale view guard | Old token must not reset current state |
| Missing instance identity guard | Same-board foreign session command rejected |
| Retaining old facts | Navigation removes disclosed facts, including hidden DOM |
| Board corruption | Visible initial board equals exact canonical source |
| Pruning exploration on undo | Visited child remains available |
| Replacing illegal intent with another move | Illegal king-facing move leaves board unchanged |
| Storage write | Initialized UI action must not call guarded storage |
| Missing focus fallback | Undo at candidate root leaves a usable board focus |
| Unfenced check during reset dialog | Completed check must not cancel confirmed reset |

These controls are additional to the original 11 core and 14 browser-core mutations.
The 11 original controls already belong to the 42 count. Model, UI and reviewer
executions overlap; results are not added into a total of independent cases.

## Preserved failures and fixes

1. The initial new model test expected an unsorted list after sorting actual keys:
   15 PASS / 1 FAIL. Corrected only the expected key order; original script and
   model-initial-failure.log remain preserved. The exact field allowlist is unchanged.
2. Initial browser run: 27 PASS and 9 effective mutations. Independent probes then
   found focus falling to BODY when Undo/Root disabled its focused button, and a
   check completing inside a reset dialog invalidating its confirmation token.
   Original app and independent probes-initial.json / probes-native-timing.json remain.
   The UI now restores focus to the roving board control, keeps the checking control
   focusable via aria-busy, and invalidates pending checks before capturing reset identity.
3. browser-02 preserved 28 completed positives and a failing reset assertion. It
   waited for the native dialog to be hidden, which precedes its queued close handler.
   The corrected probe waits for closed AND cleared returnValue, which the application
   sets only after the guarded reset handler. It still requires zero branches.
   The reset-race mutation still fails that exact oracle. The original runner and log
   are preserved; this failure was not renamed PASS.
4. browser-03: 32 PASS / 11 effective negatives. browser-final retains those checks
   and adds simulated touch to 844×390; 32 PASS / 11 effective negatives.

Historical four baseline failures (659 PASS / 4 FAIL, fixed in PR #23), Proxy reentry
P2 evidence, CRLF/LF manifest failures, scanner false positives, HTTP 503 records
and earlier environment/timing exceptions remain separate historical evidence.
PR #21 remains BLOCKED_PRODUCTION_ACCEPTANCE; Issue #22 remains OPEN and unprobed.

## Publication and visual verification

The existing Jekyll exclusion covers the entire staging directory. Local safe-mode
builds use verified raw Base Git blobs plus exact candidate bytes outside the worktree.
Artifact checks require 74 files, zero excluded leaks, no staging and 70 Runtime assets
byte-identical and SHA-256-identical to Base and the approved PR #25 artifact.
No blanket LF conversion or local CRLF manifest comparison is used.
Final source manifests and build logs accompany the external Gate report.

Screenshots in browser-final show initial and explored states at all five sizes.
Design review compares the generated full-screen concept with rendered screenshots:
warm ivory/teal palette, board/sidebar arrangement, typography, five-stage navigation,
board/piece treatment, controls, mobile order and absence of answer cues. Intentional
differences are the exact verified fixture boards, unchanged core question text,
disabled controls for unavailable actions, and real explored candidates instead of
decorative empty candidate rows. The board uses accessible native HTML controls
and vector grid lines; no raster mockup is used as a playable board.

No local PASS is GitHub CI PASS. Real devices, screen readers, human UAT, actual
BFCache restore, long-term heap/performance, learning outcomes and production
UI integration are untested. There is no cloud, AI Worker, LLM, automatic move,
localStorage/IndexedDB persistence or change to formal chess rules/Session/Schema.
