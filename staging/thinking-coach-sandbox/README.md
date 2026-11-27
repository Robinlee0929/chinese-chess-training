# U3-01B-1 Interactive Thinking Sandbox

Base: `a77d1a038e3d8ee21480ef09ab20ba4a1ca62ad9`.
This standalone staging interface is excluded by the existing Jekyll configuration.
It has no production entrypoint, persistence, AI Worker, cloud or LLM integration.

Serve the repository root with a loopback HTTP server and open
`/staging/thinking-coach-sandbox/`. Modern Chrome on localhost or HTTPS is required.
Do not use `file://` or publish the repository through a server that ignores Jekyll exclusions.

The child first observes, then proposes a move, plays the opponent's defense,
continues a variation and reflects. Nothing moves automatically. There is no
best-move ranking, candidate-match score or penalty for a legal sacrifice.
The exact questions and uncertainty text come from the existing `teaching()` API.

## Interaction and access

- A/B/C/D are the unchanged synthetic source positions from U3-01A. The runtime
  `positions.json` contains only IDs and source boards/history, never test answers.
- Select a piece and destination by mouse, simulated touch or Enter/Space.
  The 90 intersections have one roving Tab stop; arrows and Home/End move focus.
  Escape cancels selection or dismisses explicitly requested facts.
- Up to eight candidates can coexist (the existing core limit). Returning to the
  original board keeps candidates. Undo and revisiting nodes retain all explored
  children. The child may follow a different defense from any visited node.
- Candidate buttons restore each branch's cursor. The route disclosure contains
  only moves the child actually entered. No unplayed defense is in hidden markup.
- Reset asks for confirmation. Escape preserves the exercise and returns focus.
  A fixture switch starts a separate session and clears this exercise's notes.
- Notes remain in memory. Reload, reset and fixture switching clear them.

## Boundary and rendering

`app.mjs` owns DOM, focus, selection and ephemeral notes. `model.mjs` is a narrow
view adapter around the unchanged PR #25 JSON-only browser core. It does not
implement chess rules and never exposes a core/session object to the renderer.
All public model commands and results are primitive JSON text. Commands are
fenced by a unique instance key and a monotonic view version, in addition to
the core's own source/session/branch/node/revision and one-shot ticket checks.

The model reads diagnostic snapshots privately to project the current board and
the child's visited nodes. It does not pass through legal move lists, coverage,
source fingerprints, search evidence, rankings or future paths. The renderer
uses `textContent` and explicit elements; free text never becomes HTML.

Facts exist only after the child presses **檢查這一步**. The model requests a core
verification ticket, enumerates immediate replies privately, yields once, checks
the view generation and settles the original ticket. A reset, switch, navigation,
disposal or newer verification cannot apply an old result. The application also
checks the owner before painting an awaited response.

The accepted result is reduced to an explicit scalar allowlist: check/capture,
immediate reply and explored counts, terminal scope and recapture status. During
reflection it may compare counts for the child's existing candidates, always
marked unproved in quality. No reply coordinates or answer sequence are rendered,
even on request. Every state-changing operation clears disclosed facts; hidden
fact DOM is emptied. The history limitations remain visible after checking.

Security assumes a trusted JavaScript realm, as in PR #25. This is not protection
against hostile same-origin scripts or replaced browser intrinsics. Browser JSON
input restrictions deliberately differ from the original Node object API; no
equivalent browser Proxy detector is claimed. No core or formal product file changed.

## Verification

```text
node --test staging/thinking-coach-sandbox/model-test.mjs
node staging/thinking-coach-sandbox/browser-test.mjs ABSOLUTE_NEW_EXTERNAL_OUTPUT
```

Set `PLAYWRIGHT_MODULE` to an existing Playwright `index.mjs` if needed. The runner
uses full `channel: 'chrome'`, separate contexts, synthetic data, loopback-only
networking and storage/Worker guards. It checks 320×568, 375×812, 390×844,
844×390 and 1440×1000. Screenshots, HTTP request records and failures remain outside
the worktree. Mutations exist only in server memory. Initialization and module
loading occur outside negative-control catches and cannot count as detection.

Original 42 core tests (including 11 negatives), 667 baseline tests and PR #25's
29 Chrome checks/14 negatives remain separate sets. Model and UI checks overlap;
they are not added into a new independent-case total. See TEST_REPORT.md and
INDEPENDENT_REVIEW.md for evidence and limits.

No local result is GitHub CI PASS. Real devices, screen readers, human UAT, real
BFCache restoration, long-term heap/performance and learning outcomes remain
untested. The interface is not integrated into the production chessboard.
PR #21 stays BLOCKED_PRODUCTION_ACCEPTANCE and Issue #22 stays OPEN and unprobed.
This work does not authorize merge, deployment or U3-01B-2.
