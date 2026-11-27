import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './model.mjs';
import { createCoachSession } from '../thinking-coach-core/core.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('../thinking-coach-core/fixtures.json',import.meta.url))).fixtures;
const positions=JSON.parse(fs.readFileSync(new URL('./positions.json',import.meta.url)));
const fixture=id=>fixtures.find(f=>f.id===id);
const make=id=>createSandbox(JSON.stringify({sessionId:'model-test',source:fixture(id).source}));
const view=s=>JSON.parse(s.view());
const act=(s,type,fields={})=>JSON.parse(s.act(JSON.stringify({type,token:view(s).token,...fields})));
const check=s=>s.check(JSON.stringify({type:'check',token:view(s).token})).then(JSON.parse);
const start=(s,id)=>{act(s,'observe');return act(s,'move',{move:fixture(id).candidate});};

test('runtime fixtures contain only exact A/B/C/D sources; no answers',()=>{
  assert.deepEqual(positions,fixtures.map(({id,source})=>({id,source})));
  assert(!JSON.stringify(positions).includes('candidate'));assert(!JSON.stringify(positions).includes('expected'));
});
for(const id of ['A','B','C','D'])test(id+': exact initial board, successful candidate and consent-only facts',async()=>{
  const f=fixture(id),s=make(id),original=structuredClone(f.source),reference=createCoachSession({sessionId:'reference',source:f.source});
  assert.deepEqual(view(s).board,f.source.board);assert.equal(view(s).facts,null);assert.deepEqual(view(s).branches,[]);
  assert.throws(()=>act(s,'move',{move:f.candidate}),{code:'OBSERVATION_REQUIRED'});
  const next=start(s,id);reference.observe();const expected=reference.addCandidate(f.candidate).branches[0].nodes[0].position;
  assert.deepEqual(next.board,expected.board);assert.equal(next.facts,null);assert.equal(next.side,expected.sideToMove);
  assert.deepEqual(next.teaching,reference.teaching());assert.equal(next.visited.length,1);
  const result=await check(s);assert.equal(result.accepted,true);assert.equal(result.view.facts.replyCount,f.expected.replyCount);
  assert.deepEqual(result.view.facts.terminal,f.expected.terminal);assert.equal(result.view.facts.history,'NOT_PROVEN');
  assert.deepEqual(f.source,original);s.destroy();
});
test('illegal king-facing candidate is rejected atomically',()=>{
  const s=make('C');act(s,'observe');const before=s.view();
  assert.throws(()=>act(s,'move',{move:{from:{r:4,c:4},to:{r:6,c:5}}}),{code:'ILLEGAL_MOVE'});assert.equal(s.view(),before);
});
test('A retains all three child defenses through undo and node navigation',async()=>{
  const s=make('A');start(s,'A');for(const move of fixture('A').expected.replies){act(s,'move',{move});act(s,'undo');}
  assert.equal(view(s).visited.length,4);const all=view(s).visited;
  for(const n of all){const v=act(s,'node',{id:n.id});assert.equal(v.visited.find(n=>n.selected).id,n.id);assert.equal(v.visited.length,4);}
  act(s,'node',{id:all[0].id});assert.equal((await check(s)).view.facts.explored,3);
});
test('legal alternative and sacrifice kept as two candidates without ranking',async()=>{
  const s=make('B');start(s,'B');assert.equal((await check(s)).view.facts.recapture,'REFUTED');
  const first=view(s).branches[0].id;act(s,'root');act(s,'move',{move:fixture('B').expected.alternative});
  assert.equal(view(s).branches.length,2);act(s,'reflect');const facts=(await check(s)).view.facts;
  assert.equal(facts.comparisons.length,2);assert(facts.comparisons.every(c=>c.quality==='NOT_PROVEN'));
  act(s,'branch',{id:first});assert.equal(view(s).facts,null);assert.equal(view(s).selectedId,first);
});
test('default projection never exports legal moves, evidence, source identities or future routes',()=>{
  const s=make('A');for(const v of [view(s),start(s,'A'),act(s,'reflect')]){
    assert.deepEqual(Object.keys(v).sort(),['token','board','side','rootMode','selectedId','teaching','branches','visited','canUndo','canCheck','facts'].sort());
    assert.deepEqual(Object.keys(v.teaching).sort(),['question','stage','uncertainty']);assert.equal(v.facts,null);
    assert(!/legalMoves|unexplored|legalReplies|sourceFingerprint|candidateAnswer|ENGINE_SEARCH_EVIDENCE/.test(JSON.stringify(v)));
  }
});
test('moving, undo, root, branch, reflect and reset clear disclosed facts',async()=>{
  const s=make('A');start(s,'A');const branch=view(s).branches[0].id;
  for(const [type,fields] of [['move',{move:fixture('A').expected.replies[0]}],['undo',{}],['reflect',{}],['branch',{id:branch}],['root',{}]]){
    await check(s);assert(view(s).facts);act(s,type,fields);assert.equal(view(s).facts,null);
  }
  act(s,'branch',{id:branch});await check(s);act(s,'reset');assert.equal(view(s).facts,null);assert.equal(view(s).branches.length,0);assert.deepEqual(view(s).board,fixture('A').source.board);
});
test('stale view token and same-board cross-session commands rejected',()=>{
  const a=make('A'),b=make('A'),old=view(a).token,other=view(b).token;act(a,'observe');const before=a.view();
  for(const token of [old,other])assert.throws(()=>a.act(JSON.stringify({type:'reset',token})),{code:'STALE_VIEW'});
  assert.equal(a.view(),before);assert.notEqual(view(a).token.key,view(b).token.key);
});
test('queued check cannot survive reset, branch switch or disposal',async()=>{
  for(const action of ['reset','branch','destroy']){
    const s=make('B');start(s,'B');const first=view(s).branches[0].id;act(s,'root');act(s,'move',{move:fixture('B').expected.alternative});
    const pending=check(s);
    if(action==='destroy')s.destroy();else act(s,action,action==='branch'?{id:first}:{});
    assert.deepEqual(await pending,{accepted:false,reason:'STALE_VIEW'});if(action!=='destroy')assert.equal(view(s).facts,null);
  }
});
test('overlapping checks remain one-shot and ordered by the core ticket',async()=>{
  const s=make('A');start(s,'A');const first=check(s),second=check(s);
  assert.equal((await first).accepted,false);assert.equal((await second).accepted,true);
});
test('mutating view data cannot affect private board, branches or source',()=>{
  const s=make('B');start(s,'B');const before=s.view(),outside=view(s);outside.board[0][4]=null;outside.visited[0].move.to.r=0;outside.branches.length=0;
  assert.equal(s.view(),before);const v=act(s,'undo');assert.deepEqual(v.board,fixture('B').source.board);assert.equal(v.branches.length,1);
});
test('object/getter/Proxy command input is refused before reflection',()=>{
  const s=make('A');let calls=0;const input=new Proxy({}, {get(){calls++;throw new Error('trap');},ownKeys(){calls++;throw new Error('trap');}});
  assert.throws(()=>s.act(input),{code:'JSON_TEXT_REQUIRED'});assert.equal(calls,0);assert.equal(view(s).teaching.stage,'observe');
});
test('destroy is idempotent; repeated lifecycle never revives an old token',()=>{
  for(let i=0;i<30;i++){const s=make('D');const token=view(s).token;start(s,'D');act(s,'reset');s.destroy();s.destroy();assert.throws(()=>s.view(),{code:'SESSION_DESTROYED'});assert.throws(()=>s.act(JSON.stringify({type:'observe',token})),{code:'STALE_VIEW'});}
});
