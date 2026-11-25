# U3-01A Thinking Coach Core PoC

Base: `dcf2cf3333c9c7282d88dfa3d89da647baae2fb0`.

這是 Node 純邏輯 PoC，沒有 UI、AI Worker、搜尋、雲端、LLM 或儲存。
孩子先提出想法；核心只驗證與追問，不以 AI 一致率評分、不將合法替代著或犧牲判錯。
此目錄與原有 `staging/review-coach*` 並列，沒有互相引用。
既有 `_config.yml` 排除整個 `staging` 及 `.mjs`，無須修改正式 Runtime 或 Cache。
這個排除保證依賴 Jekyll Pages 建置，不能改用原始碼直接上傳。

## 模組與操作

| 模組 | 邊界 |
| --- | --- |
| `identity.mjs` | 純資料複製、遞迴凍結、SHA-256 身分指紋；拒絕 Proxy、getter、函式與循環資料 |
| `rules.mjs` | 重用既有 `game.js` 與 `validateCustomPlayPosition`，驗證來源、重播已提供歷史、枚舉全部立即合法回應 |
| `core.mjs` | Session 生命週期、候選分支樹、探索紀錄、固定問句、證據投影及一次性驗證 ticket |
| `fixtures.json` | A/B/C/D 完整 10×9 棋盤、固定預期結果及來源 SHA-256 |
| `contract-checks.mjs` | 原版與負向控制共用的行為斷言 |
| `core-test.mjs`、`negative-controls-test.mjs` | 固定局面、生命週期、證據邊界、資料隔離與記憶體變異測試 |

```js
import { createCoachSession } from './core.mjs';
// fixture.source is a plain data snapshot; no live Root/Session objects are passed in.
const coach = createCoachSession({ sessionId: 'lesson-1', source: fixture.source });
coach.teaching();                        // observe: question only
coach.observe();                         // observation acknowledged -> candidate
coach.addCandidate(childChosenMove);     // strict legality check; no automatic answer
coach.teaching();                        // defense question, no moves or coordinates
coach.play(childChosenDefense);          // explore the child's chosen reply
coach.play(childChosenContinuation);
coach.undo();                            // return to parent, retaining visited children
coach.reflect();                         // reflection question
coach.compare();                         // explicit developer API: facts, never rankings
coach.resetBranch();                     // clear this candidate's descendants and hypotheses
coach.reset();                           // clear all branches; new revision, same source
coach.invalidate();                      // terminal lifecycle; cannot be reset/reactivated
```

`addCandidate` supports up to 8 distinct legal first moves from the immutable source.
Each candidate supports 128 visited nodes; revisiting an existing child at capacity is allowed.
An illegal move or exceeded capacity changes neither board, cursor nor revision.
`play` creates or revisits a child; `undo` retains exploration; `resetBranch` deliberately clears it.
`selectBranch(id)` resumes that candidate's cursor without copying moves to another branch.

`coverage()` explicitly returns all immediate legal moves split into `explored` and `unexplored`,
bound to source/branch/node/revision. A visited reply means only that it was tried once,
not that its continuation has been proved. Even 100% immediate coverage has
`continuationProved: false`. `compare()` always compares candidate roots, not unrelated cursors.

The safe default teaching output is only `{stage, question, uncertainty}`. It follows
observation -> candidate -> defense -> variation -> reflection, and never incorporates
free-form hypotheses or answer data. `snapshot`, `coverage`, `nodeFacts`, `compare` and
`checkNoImmediateRecapture` are explicit analysis/debug APIs, not a UI view model: they may
contain the child's moves, board or enumerated replies. U3-01B must not render them as the
default teaching output. No UI integration is implemented or authorized here.

## 來源與證據契約

The source has exactly `sourceId`, `sourceSessionId`, `board`, `sideToMove`, `history`.
`history` is one of:

- `{kind: 'unknown'}`: only the supplied current position is known.
- `{kind: 'partial', root: {board, sideToMove}, moves: [{from,to}, ...]}`:
  a validated/replayed suffix, without a claim that it starts at the game origin.
- `{kind: 'complete', root: {board, sideToMove}, moves: [{from,to}, ...]}`:
  up to 1,024 moves replayed from a declared game root; the final board and side must match.

The root must pass the existing custom-position validator. Every supplied move is replayed
and checked; fabricated history keys are never accepted. A complete flag without root/moves
is rejected. “Complete” means verified from the **caller-declared** root, not authenticated
proof of earlier real-world events or full historical reachability. Future input adapters
must supply the actual trusted root; this PoC has no importer or external trust service.

| Type | Authority |
| --- | --- |
| `CANONICAL_FACT` | Locally checked legal move, capture, check, immediate reply count or terminal condition; identity and scope required |
| `ENGINE_SEARCH_EVIDENCE` | Explicitly unavailable: `SEARCH_NOT_RUN`; no engine candidates or scores accepted |
| `UNPROVEN_HYPOTHESIS` | Child's bounded text, always `proved:false`; never promoted by wording or a caller-provided flag |

For `unknown`/`partial`, all history-dependent full-game adjudication remains `NOT_PROVEN`.
The sandbox may continue through a repeated position because the missing earlier history is
not assumed. Checkmate/stalemate can be a verified **position-only** result, not a retroactive
claim about a real game's outcome. Complete history uses only the application's existing
threefold/perpetual-check rules; this is not a complete tournament adjudicator.

`checkNoImmediateRecapture()` checks only whether the last moved piece can be captured by
any legal immediate reply. It returns `REFUTED` or `SUPPORTED_FOR_NEXT_MOVE_ONLY`, never a
move-quality judgment; at terminal positions it returns `NOT_APPLICABLE_TERMINAL`.
Checking this narrowly defined claim does not rewrite or “prove” arbitrary child text.

## 身分與過期回覆

The source fingerprint includes board, side, source Session and supplied history. Position
fingerprints include the verified repetition prefix and completeness. Same board/different
history or Session is not interchangeable. Branch IDs and node IDs are monotonic within a
Session and not reused after reset.

`beginVerification()` reserves a one-shot ticket only; it starts no asynchronous work.
`settleVerification(ticket, {identity, legalReplies})` accepts only the latest original
ticket object owned by that live Session and matching the current source/branch/node/revision.
The exact reply set is rechecked, including omissions/duplicates, before a locally derived
fact is returned. Received proof labels are rejected. All edits/navigation cancel pending
tickets. Settling malformed data consumes that ticket; a stale ticket cannot consume a newer one.
Final generation checks reject lifecycle changes during processing; Proxy inputs are rejected
before reflective operations to prevent reentrant callbacks. Copied/serialized tickets are
intentionally unsupported: a future adapter must retain the original local ticket and must
not replace it with received data. This is an in-process lifecycle fence, not network authentication.

Snapshots are fresh deeply frozen copies; no writes to source Root, Session, record, stores,
localStorage or IndexedDB. The only Node dependencies are deterministic hashing and data
inspection (`node:crypto`, `node:util`); the core has no file/network/DOM/timer dependencies.

## 固定局面與驗證

Coordinates use row 0 = red home, row 9 = black home, columns 0..8. All fixtures start red.
They are synthetic, not claims of historical reachability. Full boards and fingerprints are
checked into `fixtures.json`; expected A defenses are literal oracles, not generated by the
same function under test.

| Fixture | Expected |
| --- | --- |
| A | Red rook (7,0)->(7,4) checks; exactly black rook (8,0)->(8,4), king (9,4)->(9,3), knight (9,5)->(7,4) defend |
| B | Red rook (4,0)->(6,0) captures pawn; 20 replies, including black rook (6,3)->(6,0) recapture; alternative (4,0)->(4,1) accepted |
| C | Red knight (4,4)->(5,6) illegally exposes facing kings; reject atomically; rook (2,0)->(2,4) remains legal |
| D | Red rook (8,0)->(9,0) gives immediate board mate; no continuation permitted |

Run from repository root:

```sh
node --test staging/thinking-coach-core/core-test.mjs staging/thinking-coach-core/negative-controls-test.mjs
```

Mutations operate on in-memory module copies only. Every mutant first passes the corresponding
oracle on the real implementation, then must fail a behavioral assertion (or the explicit
storage trap); import/syntax/fixture startup failures never count as successful detection.
No faults are injected into real storage, production source or the deployed site.

This core-only change has no browser acceptance claim. Existing 667 Node baseline results,
local Pages exclusion/build evidence and independent review are recorded in `TEST_REPORT.md`.
Test sets overlap (the mutation oracles reuse contract cases) and are reported separately,
not summed into independent coverage.

PR #21 remains `BLOCKED_PRODUCTION_ACCEPTANCE`; Issue #22 remains independently tracked/open.
No excluded-URL HTTP retries, deployment, merge, rollback or U3-01B work is part of this PoC.
