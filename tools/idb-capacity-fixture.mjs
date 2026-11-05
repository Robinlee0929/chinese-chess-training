import { initialBoard } from '../game.js';
import { applyCustomPositionOperation } from '../custom-position-store.js';

const time = '2026-11-02T00:00:00.000Z';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function capacityBoard(index, wide = false) {
  const board = initialBoard();
  if (wide) {
    // 153 distinct full-32-piece positions: both red cannons stay on rows 1/2.
    board[2][1] = board[2][7] = null;
    const pairs = [];
    for (let a = 0; a < 18; a++) for (let b = a + 1; b < 18; b++) pairs.push([a, b]);
    for (const cell of pairs[index]) board[1 + Math.floor(cell / 9)][cell % 9] = { type: 'C', side: 'red' };
  } else {
    [[3,0],[3,2],[3,6],[3,8],[6,0],[6,2],[6,6],[6,8]].forEach(([r,c], bit) => {
      if (index & (1 << bit)) board[r][c] = null;
    });
  }
  return board;
}

// A reachable synthetic history of 130 renames. Keeping the last 128 advances
// the base to revision 2. Extra untouched positions are present in both ends.
export function capacityFixture(count = 100, wide = false) {
  const position = i => ({ id: wide ? '界'.repeat(125) + String(i).padStart(3, '0') : 'seed-' + i,
    title: wide ? '🀄'.repeat(60) : 'test ' + i, initialBoard: capacityBoard(i, wide), sideToMove: 'red',
    createdAt: time, updatedAt: time, playPreferences: { humanSide: 'black', difficulty: 'medium' } });
  let envelope = { version: 1, revision: 0, positions: [position(0)] };
  const metadata = { version: 1, storageInstanceId: uuid(1), baseEnvelope: structuredClone(envelope), commits: [], committedOperationIds: [], lastCommit: null };
  for (let i = 0; i < 130; i++) {
    const command = { type: 'rename', id: envelope.positions[0].id,
      title: wide ? '🀄'.repeat(59) + String(i % 10) : 'step ' + i };
    const operation = { storageInstanceId: metadata.storageInstanceId, expectedRevision: i,
      operationId: `${metadata.storageInstanceId}/${i}/${uuid(i + 1000)}`,
      command, preparedAt: time, positionId: uuid(i + 2000) };
    const next = applyCustomPositionOperation(envelope, command, { now: () => time }).envelope;
    const receipt = { operation, revision: i + 1, committedAt: time,
      delta: { index: 0, before: envelope.positions[0], after: next.positions[0] } };
    envelope = structuredClone(next); metadata.commits.push(receipt);
    if (metadata.commits.length > 128) {
      const oldest = metadata.commits.shift();
      metadata.baseEnvelope = { version: 1, revision: oldest.revision, positions: [oldest.delta.after] };
    }
  }
  const rest = Array.from({ length: count - 1 }, (_, i) => position(i + 1));
  envelope.positions.push(...rest); metadata.baseEnvelope.positions.push(...structuredClone(rest));
  metadata.committedOperationIds = metadata.commits.map(r => r.operation.operationId);
  const last = metadata.commits.at(-1);
  metadata.lastCommit = { operationId: last.operation.operationId, revision: last.revision, committedAt: time };
  return structuredClone({ envelope, metadata });
}
