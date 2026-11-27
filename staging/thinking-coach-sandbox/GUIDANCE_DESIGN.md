# Evidence-based guidance contract

Base: `67ed4f5ece5f1c9a47bfd38b5507a41afd560875`. Staging only.

The child observes threats, gives a candidate and reason, forecasts a defense,
tries variations and revises their own interpretation. A legal alternative or
sacrifice is never scored wrong. This prototype measures no teaching outcomes.

## Responsibilities

- `teaching-adapter.mjs`: accepts primitive JSON with an exact whitelist of stage,
  hint level and validated boolean flags. Selects literal questions. It receives
  neither free text nor move lists and cannot grade or infer ability from text.
- `guidance-model.mjs`: wraps the unchanged sandbox and JSON-only browser core.
  Owns contextual drafts, archived revisions, forecasts, explored projections and
  requested scalar facts. The underlying core remains the rule authority.
- `app.mjs`: renders text with `textContent`; owns selection and focus. It never
  renders diagnostic snapshots, legal-response arrays or search candidates.

## Three hint levels

1. A fixed question about where to look: threats, protection or the opponent's turn.
2. A fixed calculation method: one ply at a time, king safety, captures and recaptures.
   A verified mismatch may select a question about revising the child's prediction.
3. Explicitly requested verification of the child's submitted prediction or played
   move. No automatic best move, untried reply coordinates or complete variation.

Forecasting marks a from/to pair without moving the visible board. Verification
creates a private core session from the original JSON source, replays only the
child's route and attempts the submitted move. Illegal moves leave the actual
board unchanged. Successful facts are reduced to legality, check, capture and
existence of an immediate legal recapture. The declared source history is retained;
an unknown history cannot prove historical adjudication. The probe is always destroyed.

## Evidence and memory

Child text and forecasts are `UNPROVEN_HYPOTHESIS`. Verified rule facts are
`CANONICAL_FACT` within their stated scope. No engine search is run and no
`ENGINE_SEARCH_EVIDENCE` is fabricated. Exhausting immediate replies does not prove
a longer line, optimality or a best move. Reflection does not generate conclusions.

Records use session instance key, reset epoch, candidate ID, node ID and stage.
Each context retains up to 16 archived text revisions and one replaceable current
draft, plus up to 16 submitted predictions. Text is limited to 300 characters.
After the revision limit, later edits replace only the current draft; the first
16 revisions stay intact. The UI explains this and allows navigation/reset.
At 1024 contexts, new note/forecast input is disabled for contexts without a record;
existing records remain accessible and navigation/reset still work. A root reason
is copied to the first candidate node only when capacity allows; otherwise the
original root record remains in reflection. These are bounded memory contracts,
not durable journal storage.

Reset, fixture change, reload and destroy discard records. No localStorage,
IndexedDB, production store API, AI Worker, cloud or LLM is used. Changing the
optional target changes no move legality or progression requirement.

## Asynchronous and UI boundaries

Every command is primitive JSON; objects, Proxy and getters are rejected before
reflection. Commands carry the authoritative view key/version. The underlying
source/session/node/revision/ticket checks are unchanged. A wrapper generation and
one-shot ticket reject navigation/reset/edit/disposal races. Prediction and played
position checks share a busy guard so mixed checks cannot silently advance the
underlying version. The renderer additionally checks model ownership.

Typing updates the contextual draft immediately, invalidating an awaited result.
Navigation flushes a revision when capacity permits. Selection changes are captured
before that flush can rerender controlled fields. Reset invalidates pending checks
before capturing the confirmation token. Cancel preserves notes and returns focus.
Hidden fact sections are emptied; accessibility names contain only visible board
pieces and coordinates or child-entered routes, never untried solutions.

The trusted-realm assumption from PR #25 remains. This does not defend against
hostile same-origin JavaScript or replaced browser intrinsics. No browser Proxy
detector equivalent to Node's is claimed.

## Known limits

Chrome tests use synthetic data and simulated touch. Real devices, screen readers,
human UAT, actual BFCache restoration, long-term performance and teaching outcomes
are untested. The interface is intentionally excluded from the public Pages site.
PR #21 remains `BLOCKED_PRODUCTION_ACCEPTANCE`; Issue #22 stays open and unprobed.
