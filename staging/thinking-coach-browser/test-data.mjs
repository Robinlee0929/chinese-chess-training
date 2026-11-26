import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createCoachSession } from '../thinking-coach-core/core.mjs';
import { stable } from '../thinking-coach-core/identity.mjs';
export const fixtures = JSON.parse(fs.readFileSync(new URL('../thinking-coach-core/fixtures.json',import.meta.url))).fixtures;
export const expected = Object.fromEntries(fixtures.map(f=>{
  const s=createCoachSession({sessionId:'browser-check',source:f.source}),initial=s.snapshot();
  s.observe();s.addCandidate(f.candidate);return [f.id,{initial,candidate:s.snapshot(),facts:s.nodeFacts(),coverage:s.coverage()}];
}));
expected.historyCases = ['partial','complete'].map(kind=>{
  const f=fixtures[0],node=expected.A.candidate.branches[0].nodes[0].position;
  const source={...structuredClone(f.source),board:structuredClone(node.board),sideToMove:node.sideToMove,
    history:{kind,root:{board:structuredClone(f.source.board),sideToMove:f.source.sideToMove},moves:[f.candidate]}};
  const s=createCoachSession({sessionId:'history-replay',source}),initial=s.snapshot();
  s.observe();s.addCandidate(f.expected.replies[0]);return {source,initial,candidate:s.snapshot(),facts:s.nodeFacts()};
});
export const vectors = ['', 'abc', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 'a'.repeat(1000000),
  ...[1,55,56,63,64,65,127,128,129,1024,4096].map(n=>'x'.repeat(n)), '象棋🙂\uD800\uDC00\uD800',
  ...fixtures.map(f=>stable(f.source)), ...Array.from({length:50},(_,i)=>Array.from({length:i*17},(_,j)=>String.fromCharCode((j*997+i*53)%65536)).join(''))]
  .map(text=>({text,sha256:createHash('sha256').update(text).digest('hex')}));
