# Portable Game Transfer V1 — data core, export and temporary import

The frozen Phase A data contract now supports three Phase B download entries:
live games, the completed-game overlay, and the whole original completed record
in review. Phase C adds JSON import and temporary read-only review. The AI engine, game rules and storage
adapters are unchanged. Never wire the synchronous parser into a UI handler.

`export-source.js` captures an immutable nine-field document and private source
identity, including session reference, revision, board, history and repetition
metadata. Busy/AI-thinking, invalidated and fail-closed sources are rejected.
`export-controller.js` validates in the dedicated Worker, rechecks the source and
compares canonical replay to the live board/history before downloading. Stale
operations, cancellation and pagehide cannot download; each operation settles once.
`export-format.js` only renders already validated data. The public Phase A
serializers still validate first; UI export never replays the game on the main thread.
Old stored records export unknown player ownership as null. Memory-only completed
records remain exportable after storage failure. Export writes no persistent data.
The UI capability marker keeps mixed old/new HTML and JS fail-closed. All runtime
imports and the Worker URL share the cache version, including nested modules.

Phase C's `import-controller.js` admits JSON files, cancels bounded FileReader
operations and delegates complete validation to the unchanged Phase A Worker.
Generation, context revision and operation identity reject stale selection,
cancelled reads, late replies and repeated confirmation. `import-ui.js` uses a
native modal and textContent for the preview; only explicit confirmation enters
review. An unreadable GameRecord store does not block this independent path.

`imported-review.js` is a separate model with `sourceKind: imported`, private local
source identity and per-selection revision. It holds the frozen canonical result;
navigation only folds already validated coordinates and uses canonical metadata.
It never creates a Completed GameRecord or Teaching Handoff for an incomplete game.
Continuation requires the exact current review, reacquires a detached canonical
snapshot and starts a fresh normal Session without source IDs or prefix history.
Imported review has runtime guards against analysis, teaching, deletion and puzzle
creation. Import, preview, cancel and navigation write no persistent storage.

## Frozen candidate contract

One file contains one game. Exactly these nine root fields are required:

| Field | Accepted value |
| --- | --- |
| `format` | `chinese-chess-training-game-transfer` |
| `schemaVersion` | integer `1` |
| `exportedAt` | valid millisecond UTC ISO timestamp |
| `initialPosition` | exactly `{board, sideToMove}` |
| `moves` | coordinate-only `{from:{r,c}, to:{r,c}}` array |
| `mode` | `easy`, `medium`, `hard`, `experimental-b`, `pvp` |
| `playerSide` | `red`, `black`, or `null`; pvp requires `null` |
| `status` | `in-progress` or `completed` |
| `result` | `null` for incomplete; otherwise `{winner, terminationReason}` |

Unknown player ownership remains `null`, including old records. It is never
derived from side-to-move or mode. A file contains no Session/storage IDs,
completion timestamp, teaching metadata, photos, scores or imported notation.

Boards are exactly 10 rows of 9 cells, each `null` or `{type, side}`. Types are
`K/A/B/N/R/C/P`; sides are `red/black`. Row 0 is the red home rank, row 9 black;
columns are 0–8 in engine coordinates, independent of camera orientation.

Limits: **1,048,576 raw UTF-8 bytes**, **1,024 plies**, **16 nested JSON containers**
(the root object is depth 1). Raw size includes whitespace and an optional single
UTF-8 BOM. Malformed UTF-8 is rejected. Unknown fields, duplicate decoded object
keys, unsupported versions and trailing JSON content are rejected. No truncation.

Both sides need exactly one king, piece counts obey existing custom-play limits,
kings remain in their palaces, kings cannot face, and the non-moving side cannot
already be checked. Reachability from the standard opening is not asserted.
The custom-play validator's terminal-only rejection is exempted solely for a
completed zero-ply game; its preceding checks remain mandatory. A normal
nonterminal initial board can have zero plies only as an incomplete game.

Every move and terminal result uses the existing game-record replay and game.js
rules. Incomplete games use a Timeline, never a fabricated completed record.
Completed games reuse `createSessionGameRecord()` with disposable local adapter
metadata, which is never returned as a storage record. Accepted terminal reasons:
`checkmate`, `stalemate`, `perpetual-check`, `threefold-repetition`,
`mutual-perpetual-check`. Winner is `red`, `black`, or `null` for a draw. The final
replayed result must match exactly; no moves may follow the first terminal.

## APIs

- `validateGameTransfer(document)` returns frozen `{document, replay}`; this is a
  synchronous pure-data API for trusted callers, tests and the Worker.
- `parseGameTransfer(string | Uint8Array | ArrayBuffer)` performs byte/UTF-8,
  duplicate-key/depth/schema and full legal-replay validation, returning the same
  frozen shape. Binary views preserve their actual byte offset and length.
- `serializeGameTransfer(document)` revalidates, writes canonical pretty JSON
  without BOM, and terminates with LF.
- `serializeGameTransferTXT(document)` revalidates and emits Chinese UTF-8 text
  with BOM/LF, initial board, actual mover order, canonical notation, coordinates,
  captures, player ownership and the verified result. TXT cannot be imported.
- `createGameTransferValidationClient().validate(input, {signal})` returns a
  promise of the validated result using a fresh module Worker. `.cancel()` and
  `.dispose()` terminate it. A new validation cancels the previous one.

The Worker deadline is fixed at **10,000 ms**, including startup. Both a timer and
the monotonic deadline check reject late completion. Startup/network/runtime or
protocol errors fail closed; no main-thread replay fallback exists. Returned
structured-clone data is frozen again on the client. Phase C owns the file picker,
MIME/extension admission and Chinese import errors; Phase B owns export operation
UI and Chinese export errors separately.

The client snapshots the admitted input bytes before dispatch. Successful replies
must have the exact envelope, document and full replay shapes, and match that
immutable request. `worker-protocol.js` checks only the bounded wire protocol:
16 container levels, 65,536 visited values, arrays of at most 1,025 entries,
512 characters per string and 1 MiB total string characters. Cycles, accessors,
unknown fields and exotic objects are rejected before comparison or freezing.
After Worker success, native JSON decoding (at most 1 MiB) correlates the original
request with the returned document. A linear coordinate consistency fold checks
metadata/captures/turns, board fingerprints and the final board (at most 1,024
moves times 90 cells). It does not generate legal moves, compute check/terminal
results, or generate notation. Those domain decisions, and strict duplicate-key
validation, remain trusted results of the dedicated Worker. There is no parser
or chess-validation fallback after Worker failure.

Response processing and freezing stay inside a guarded active request and the
same 10-second deadline. Only then may success settle. Any processing exception
rejects as `INVALID_WORKER_RESPONSE`; teardown is attempted for every resource
and cannot prevent promise settlement. Stale request IDs are ignored, with the
current request's deadline still active. Other malformed replies fail closed.

Errors are `GameTransferError` with `code`, message and optional `path`, `ply`,
`offset`, `byteLength`. Key codes: `INVALID_INPUT`, `FILE_TOO_LARGE`, `INVALID_UTF8`,
`INVALID_JSON`, `DUPLICATE_FIELD`, `MAX_DEPTH_EXCEEDED`, `INVALID_OBJECT`,
`UNEXPECTED_FIELDS`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_SCHEMA_VERSION`,
`INVALID_EXPORTED_AT`, `UNSUPPORTED_MODE`, `INVALID_PLAYER_SIDE`,
`PLAYER_SIDE_MODE_MISMATCH`, `INVALID_STATUS`, `UNEXPECTED_RESULT`, `TOO_MANY_PLIES`,
`NONTERMINAL_COMPLETED_GAME`, `TERMINAL_INCOMPLETE_GAME`, `RESULT_MISMATCH`, plus
the existing board/coordinate/move/initial-position validation codes. Worker
lifecycle codes: `CANCELLED`, `DISPOSED`, `VALIDATION_TIMEOUT`,
`VALIDATOR_UNAVAILABLE`, `INVALID_WORKER_RESPONSE`, `VALIDATION_FAILED`.

## Verification and integration boundary

Run `node --test game-transfer-test.mjs game-transfer-worker-test.mjs`.
`tools/game-transfer-performance.mjs` takes a new evidence directory outside the
checkout and an existing Playwright module via `PLAYWRIGHT_MODULE`. It uses only
localhost and an isolated Chrome profile. Real 1,024-ply fixtures are generated
legally, with a completed fixture reaching repetition on its final ply; test
files are padded with legal whitespace to exactly 1 MiB, not fake move padding.
It measures actual Workers, main-thread heartbeat and execution-target isolation,
cancellation/recovery and a real ten-second silent-Worker timeout. The synchronous
reply-handler duration is measured separately; heartbeat gaps include the final
reply task so protocol costs cannot disappear when the heartbeat is stopped.

Pure-data nonstandard pvp fixtures do not add a product entry point. An imported
pvp file can be reviewed, but continuation only offers the four existing AI modes.
No new persistence, external-format import, cloud synchronization or AI analysis
is provided.

The cache tool now includes `game-transfer/` runtime modules and their `../`
dependencies. Jekyll publishes the runtime graph; `.mjs` tests and tools remain
excluded by the unchanged Pages configuration. Run `game-export-test.mjs` for
source identity, lifecycle and download tests, and `tools/game-export-browser-test.mjs`
against a built artifact for desktop/mobile real downloads and JSON round trips.
All browser profiles, downloaded files and evidence must stay outside the checkout.

Run `node --test game-import-test.mjs` for canonical snapshots, all terminal
reasons, controller races, FileReader teardown and Worker negative cases. Run
`tools/game-import-browser-test.mjs SITE NEW_EVIDENCE_DIR [PHASE_B_SOURCE]` with
PLAYWRIGHT_MODULE configured for separate producer/consumer Chrome contexts,
desktop/mobile file input, every-ply replay, new Sessions, storage isolation,
keyboard, invalid files, Worker failures and compatible mixed assets. It also
tries Firefox with the same actual Chrome download. The optional Phase B snapshot
tests capability gating; the frozen V1 Worker remains compatible across B/C.
