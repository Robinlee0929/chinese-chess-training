# Independent review — U3-01B-1

Base: `a77d1a038e3d8ee21480ef09ab20ba4a1ca62ad9`.
Reviewer: separate read-only agent `u301b1_independent_review`.
Evidence directory: `C:/Users/Robin/AppData/Local/Temp/chess-u3-01b1-review-20261127`.

The reviewer independently examined the model, renderer, runtime fixture projection,
keyboard/focus flow, reset lifecycle and tests. The reviewer did not modify the
implementation or use the implementer's browser context.

Independent executions:

- Model: 16 PASS / 0 FAIL.
- Original core: 42 PASS / 0 FAIL, including its 11 negative controls.
- Final full Chrome UI runner: 32 PASS, 11/11 mutations detected, 43 isolated contexts.
  `browser-final-03/results.json` uses the final landscape-touch conditions.
- Additional original/native scheduling probes confirmed both repaired UI issues.
- Existing 667 baseline / 29 browser-core checks / 14 browser-core mutations / 70
  SHA vectors were checked against the implementer's preserved evidence; they are
  not falsely described as a separate reviewer rerun.

## Findings and resolution

1. Undo at the candidate root and Return to Source disabled the focused control,
   leaving focus on BODY. The renderer now restores focus to the board's existing
   roving control, without adding Tab stops. Checking uses aria-busy instead of
   temporarily disabling its focused button. Independent probes confirmed usable
   focus after Undo/Root and retained focus after Check.
2. A check completing after Reset opened could change the view version and make the
   confirmation token stale. Reset now invalidates pending checks via clearFacts
   before capturing the guarded token. Session identity/revision checks remain
   required. Original native Chrome scheduling reproduced the issue; independent
   fixed probes confirmed zero branches after reset and focus on the reset control.

Initial findings and native-timing evidence are preserved in probes-initial.json
and probes-native-timing.json. Fixed evidence is probes-fixed-timing.json.
Both findings have dedicated working fault injections in the final browser suite.
No unresolved P1/P2 was identified in the final code/function review.

The implementer's browser-02 waited for dialog visibility before the queued close
handler applied reset. The final probe waits for closed plus cleared returnValue,
then still asserts zero branches. The injected reset-race implementation clears
returnValue but retains a branch, so this probe still detects the defect. The failed
run and pre-fix probe remain preserved; no historical failure is relabeled PASS.

## Security and publication scope

The unchanged PR #25 core owns private source/Session/ticket data. The model accepts
primitive JSON command text and fences instance/version before dispatch. Explicit
facts are separately allowed by the child; diagnostic legal reply arrays never pass
to the renderer. Default visible/hidden DOM and accessibility names were checked.
No storage entrypoint, Worker, cloud or LLM call is introduced.

The external final review and document/artifact supplement record exact file hashes,
the final safe-mode Jekyll output, runtime byte equality and worktree/Snapshot
protection. An intermediate artifact retained the older landscape test condition;
the source consistency checker correctly rejected it for final approval. That
verifier log is retained, and final approval uses a fresh artifact of all ten files.

Local tests are not GitHub CI PASS. The tested set overlaps across implementation
and review runs and must not be summed as independent cases. Real devices, screen
readers, human UAT, real BFCache, long-term profiling and learning outcomes remain
untested. PR #21 stays BLOCKED_PRODUCTION_ACCEPTANCE; Issue #22 stays OPEN and is
not retested. Final release/merge authorization is outside this Draft PR's scope.
