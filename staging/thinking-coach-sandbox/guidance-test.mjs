import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuidedSandbox } from './guidance-model.mjs';
import { teaching } from './teaching-adapter.mjs';
import { createCoachSession } from '../thinking-coach-core/core.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('../thinking-coach-core/fixtures.json',import.meta.url))).fixtures;
const f=id=>fixtures.find(f=>f.id===id),make=id=>createGuidedSandbox(JSON.stringify({sessionId:'guidance',source:f(id).source}));
const v=s=>JSON.parse(s.view()),cmd=(s,type,extra={})=>JSON.stringify({type,token:v(s).token,...extra});
const act=(s,type,extra={})=>JSON.parse(s.act(cmd(s,type,extra))),guide=(s,type,extra={})=>JSON.parse(s.guide(cmd(s,type,extra)));
const write=(s,text)=>guide(s,'write',{text}),start=(s,id)=>{act(s,'observe');return act(s,'move',{move:f(id).candidate});};
const forecast=(s,move,expect={check:'unsure',capture:'unsure',recapture:'unsure'})=>guide(s,'forecast',{move,expect});
const verify=s=>s.verifyPrediction(cmd(s,'verifyPrediction')).then(JSON.parse),check=s=>s.check(cmd(s,'check')).then(JSON.parse);

test('adapter deterministically asks questions without accepting free text or move evidence',()=>{
  for(const stage of ['observe','candidate','defense','variation','reflect'])for(const level of [1,2,3]){
    const c=JSON.stringify({stage,level,hasRecord:false,hasPrediction:false,mismatch:false}),a=teaching(c);
    assert.equal(a,teaching(c));assert(!/最佳著|\"from\"|\"to\"|legalReplies/.test(a));assert.equal(JSON.parse(a).level,level);
    assert.throws(()=>teaching(JSON.stringify({...JSON.parse(c),text:'我是高手'})),/INVALID_TEACHING_CONTEXT/);
  }
});
for(const id of ['A','B','C','D'])test(id+' canonical position and consent-only evidence match unchanged core',async()=>{
  const s=make(id),original=JSON.stringify(f(id).source),reference=createCoachSession({sessionId:'ref',source:f(id).source});
  assert.equal(v(s).guidance.disclosure,null);assert.deepEqual(v(s).guidance.summary,[]);start(s,id);reference.observe();const target=reference.addCandidate(f(id).candidate).branches[0].nodes[0].position;
  assert.deepEqual(v(s).board,target.board);assert.equal(v(s).facts,null);const result=await check(s);assert(result.accepted);assert.equal(result.view.facts.replyCount,f(id).expected.replyCount);assert.deepEqual(result.view.facts.terminal,f(id).expected.terminal);
  assert.equal(JSON.stringify(f(id).source),original);s.destroy();
});
test('observations, candidate reasons and branch predictions never overwrite one another',()=>{
  const s=make('B');write(s,'先看車受到什麼威脅');act(s,'observe');write(s,'候選一：吃子後還要計算回吃');act(s,'move',{move:f('B').candidate});const first=v(s).selectedId;
  write(s,'對方也許吃回');forecast(s,f('B').expected.recapture);act(s,'root');write(s,'候選二：先移開');act(s,'move',{move:f('B').expected.alternative});const second=v(s).selectedId;
  write(s,'不同防守');forecast(s,{from:{r:9,c:4},to:{r:8,c:4}});act(s,'branch',{id:first});assert.equal(v(s).guidance.text,'對方也許吃回');assert.deepEqual(v(s).guidance.prediction.move,f('B').expected.recapture);
  act(s,'reflect');const rows=v(s).guidance.summary;
  assert(rows.some(r=>r.context.branch===null&&r.context.stage==='observe'&&r.texts[0]==='先看車受到什麼威脅'));
  assert(rows.some(r=>r.context.branch===first&&r.context.stage==='candidate'&&r.texts[0].startsWith('候選一')));
  assert(rows.some(r=>r.context.branch===second&&r.context.stage==='candidate'&&r.texts[0].startsWith('候選二')));
  assert(rows.every(r=>r.context.session===v(s).token.key&&r.kind==='UNPROVEN_HYPOTHESIS'));
});
test('prediction is atomic, retains its own coordinates and returns only requested scalar facts',async()=>{
  const s=make('B');start(s,'B');const board=v(s).board,route=v(s).visited;
  forecast(s,f('B').expected.recapture,{check:'no',capture:'no',recapture:'unsure'});const result=await verify(s),d=result.view.guidance.disclosure;
  assert(result.accepted);assert.equal(d.facts.legal,true);assert.equal(d.facts.capture,true);assert.equal(d.mismatch,true);assert.equal(d.facts.kind,'CANONICAL_FACT');assert.equal(d.facts.continuationProved,false);
  assert(!/legalMoves|legalReplies|unexplored|\"from\"|\"to\"/.test(JSON.stringify(d)));assert.deepEqual(v(s).board,board);assert.deepEqual(v(s).visited,route);
  guide(s,'hint',{level:2});assert.match(v(s).guidance.prompt.question,/與你的預測不同/);
});
test('wrong prediction can be revised without rewriting earlier hypothesis or grading text',async()=>{
  const s=make('B');start(s,'B');write(s,'一定安全！');forecast(s,f('B').expected.recapture,{check:'no',capture:'no',recapture:'no'});await verify(s);
  write(s,'我漏看了回吃，想改看另一條路線');forecast(s,f('B').expected.recapture,{check:'no',capture:'yes',recapture:'unsure'});const d=(await verify(s)).view.guidance.disclosure;assert.equal(d.mismatch,false);
  act(s,'reflect');const row=v(s).guidance.summary.find(r=>r.context.stage==='defense');assert.equal(row.texts.length,2);assert.equal(row.predictions.length,2);assert.equal(row.predictions[0].expect.capture,'no');assert.equal(row.predictions[1].expect.capture,'yes');assert(row.predictions.every(p=>p.kind==='UNPROVEN_HYPOTHESIS'));
});
test('illegal prediction and illegal candidate leave board/route unchanged',async()=>{
  const s=make('C');act(s,'observe');const before=s.view();assert.throws(()=>act(s,'move',{move:{from:{r:4,c:4},to:{r:6,c:5}}}),{code:'ILLEGAL_MOVE'});assert.equal(s.view(),before);
  act(s,'move',{move:f('C').candidate});const board=v(s).board,route=v(s).visited;forecast(s,{from:{r:9,c:4},to:{r:4,c:4}});assert.equal((await verify(s)).view.guidance.disclosure.facts.legal,false);assert.deepEqual(v(s).board,board);assert.deepEqual(v(s).visited,route);
});
test('terminal D rejects further predicted moves without inventing a continuation',async()=>{
  const s=make('D');start(s,'D');forecast(s,{from:{r:9,c:4},to:{r:8,c:4}});const r=await verify(s);assert.equal(r.view.guidance.disclosure.facts.legal,false);assert.equal(r.view.guidance.disclosure.facts.continuationProved,false);
});
test('all immediate defenses and three plies do not prove a full line or best move',async()=>{
  const s=make('A');start(s,'A');const root=v(s).visited[0].id;
  for(const m of f('A').expected.replies){forecast(s,m);assert.equal((await verify(s)).view.guidance.disclosure.facts.legal,true);act(s,'move',{move:m});write(s,'這一條的紀錄');act(s,'undo');}
  assert.equal((await check(s)).view.facts.explored,3);assert.equal(v(s).visited.length,4);
  const core=createCoachSession({sessionId:'depth',source:f('A').source});core.observe();core.addCandidate(f('A').candidate);core.play(f('A').expected.replies[0]);const third=core.coverage().unexplored[0];
  act(s,'move',{move:f('A').expected.replies[0]});act(s,'move',{move:third});assert.equal(v(s).guidance.depth,3);act(s,'node',{id:root});assert.equal(v(s).guidance.depth,1);assert.equal(v(s).visited.length,5);
  act(s,'reflect');assert.match(v(s).guidance.prompt.boundary,/不代表完整變化/);assert(v(s).guidance.summary.every(x=>x.kind==='UNPROVEN_HYPOTHESIS'));
});
test('node and phase records survive undo/root/branch selection independently',()=>{
  const s=make('A');start(s,'A');write(s,'候選節點');const candidate=v(s).visited[0].id;act(s,'move',{move:f('A').expected.replies[0]});write(s,'防守節點');const reply=v(s).visited.find(n=>n.selected).id;
  act(s,'undo');assert.equal(v(s).guidance.text,'候選節點');act(s,'node',{id:reply});assert.equal(v(s).guidance.text,'防守節點');act(s,'reflect');write(s,'反思在另一個階段');act(s,'node',{id:reply});assert.equal(v(s).guidance.text,'防守節點');act(s,'node',{id:candidate});assert.equal(v(s).guidance.text,'候選節點');
});
test('legal alternative and sacrifice are retained without scores or correctness rankings',async()=>{
  const s=make('B');start(s,'B');assert.equal((await check(s)).view.facts.recapture,'REFUTED');act(s,'root');act(s,'move',{move:f('B').expected.alternative});assert.equal(v(s).branches.length,2);act(s,'reflect');assert((await check(s)).view.facts.comparisons.every(x=>x.quality==='NOT_PROVEN'));
});
test('challenge depth is adjustable and optional; branching count is not path depth',()=>{
  const s=make('A');assert.deepEqual(v(s).guidance.target,{candidates:2,plies:3});guide(s,'target',{candidates:1,plies:5});start(s,'A');for(const m of f('A').expected.replies){act(s,'move',{move:m});act(s,'undo');}assert.equal(v(s).guidance.depth,1);act(s,'reflect');assert.equal(v(s).teaching.stage,'reflect');
  const before=s.view();assert.throws(()=>guide(s,'target',{candidates:8,plies:99}),{code:'INVALID_TARGET'});assert.equal(s.view(),before);
});
test('JSON-only APIs reject Proxy/getters and malformed input without traps or mutations',async()=>{
  const s=make('A');let calls=0;const bad=new Proxy({}, {get(){calls++;throw Error('getter');},ownKeys(){calls++;throw Error('keys');}});const before=s.view();
  assert.throws(()=>s.act(bad),{code:'JSON_TEXT_REQUIRED'});assert.throws(()=>s.guide(bad),{code:'JSON_TEXT_REQUIRED'});await assert.rejects(()=>s.verifyPrediction(bad),{code:'JSON_TEXT_REQUIRED'});assert.equal(calls,0);assert.equal(s.view(),before);
  for(const fields of [{text:'x'.repeat(301)},{text:42},{text:'x',kind:'CANONICAL_FACT'}])assert.throws(()=>guide(s,'write',fields));assert.equal(s.view(),before);
});
test('stale and cross-session writes and forecasts are refused even for same board',()=>{
  const a=make('A'),b=make('A'),old=v(a).token,foreign=v(b).token;act(a,'observe');const before=a.view();for(const token of [old,foreign])assert.throws(()=>a.guide(JSON.stringify({type:'write',token,text:'污染'})),{code:'STALE_VIEW'});assert.equal(a.view(),before);
});
for(const action of ['reset','root','branch','write','destroy'])test('pending prediction rejects '+action+' without altering a new context',async()=>{
  const s=make('B');start(s,'B');forecast(s,f('B').expected.recapture);const pending=verify(s);
  if(action==='destroy')s.destroy();else if(action==='write')write(s,'新說法');else act(s,action,action==='branch'?{id:v(s).selectedId}:{});
  assert.equal((await pending).accepted,false);if(action!=='destroy')assert.equal(v(s).guidance.disclosure,null);
});
test('mixed verification types serialize and leave a usable current token',async()=>{
  for(const first of ['played','prediction']){
    const s=make('B');start(s,'B');forecast(s,f('B').expected.recapture);const one=first==='played'?check(s):verify(s),two=first==='played'?verify(s):check(s);
    assert.equal((await two).reason,'CHECK_PENDING');assert.equal((await one).accepted,true);write(s,'仍可記錄');assert.equal(v(s).guidance.text,'仍可記錄');
  }
});
test('reset/reload/destroy clear records and reject previous tokens',()=>{
  const s=make('B');write(s,'觀察');start(s,'B');write(s,'理由');forecast(s,f('B').expected.recapture);const before=v(s).guidance.context;act(s,'reset');assert.equal(v(s).guidance.context.epoch,before.epoch+1);assert.equal(v(s).guidance.text,'');assert.equal(v(s).guidance.prediction,null);start(s,'B');act(s,'reflect');assert.deepEqual(v(s).guidance.summary,[]);assert.equal(v(make('B')).guidance.text,'');s.destroy();s.destroy();assert.throws(()=>s.view(),{code:'SESSION_DESTROYED'});
});
test('known source history is preserved in prediction facts rather than silently dropped',async()=>{
  const source=JSON.parse(JSON.stringify(f('B').source));source.history={kind:'complete',root:{board:source.board,sideToMove:source.sideToMove},moves:[]};const s=createGuidedSandbox(JSON.stringify({sessionId:'history',source}));start(s,'B');forecast(s,f('B').expected.recapture);assert.equal((await verify(s)).view.guidance.disclosure.facts.history,'VERIFIED_FROM_DECLARED_ROOT');
});
test('mutating returned records or boards cannot touch private history or source',()=>{
  const s=make('B');start(s,'B');write(s,'原始');forecast(s,f('B').expected.recapture);const original=s.view(),outside=v(s);outside.guidance.prediction.move.from.r=0;outside.guidance.revisions.push('改寫');outside.board[0][4]=null;assert.equal(s.view(),original);
});
test('structured expectation drafts belong to their branch, node and phase and clear on reset',()=>{
  const s=make('B'),yes={check:'yes',capture:'yes',recapture:'yes'},no={check:'no',capture:'no',recapture:'no'},unknown={check:'unsure',capture:'unsure',recapture:'unsure'};
  start(s,'B');const first=v(s).selectedId;guide(s,'expect',{expect:yes});act(s,'root');act(s,'move',{move:f('B').expected.alternative});assert.deepEqual(v(s).guidance.expect,unknown);guide(s,'expect',{expect:no});act(s,'branch',{id:first});assert.deepEqual(v(s).guidance.expect,yes);
  act(s,'reflect');assert.deepEqual(v(s).guidance.expect,unknown);guide(s,'expect',{expect:no});act(s,'branch',{id:first});assert.deepEqual(v(s).guidance.expect,yes);act(s,'move',{move:f('B').expected.recapture});assert.deepEqual(v(s).guidance.expect,unknown);act(s,'undo');assert.deepEqual(v(s).guidance.expect,yes);act(s,'reset');assert.deepEqual(v(s).guidance.expect,unknown);
});
test('typing during either asynchronous check invalidates the result and preserves the draft',async()=>{
  for(const mode of ['played','prediction']){const s=make('B');start(s,'B');forecast(s,f('B').expected.recapture);const pending=mode==='played'?check(s):verify(s);guide(s,'draft',{text:'正在寫的新反思'});assert.equal((await pending).accepted,false);assert.equal(v(s).guidance.text,'正在寫的新反思');assert.equal(v(s).guidance.disclosure,null);assert.equal(v(s).facts,null);}
});
test('keystrokes replace only the current draft; explicit revisions and candidate reason remain',()=>{
  const s=make('B');act(s,'observe');for(let i=0;i<50;i++)guide(s,'draft',{text:'理由 '+i});assert.equal(v(s).guidance.revisions.length,0);write(s,'理由 49');guide(s,'draft',{text:'修正後的理由'});assert.deepEqual(v(s).guidance.revisions,['理由 49']);act(s,'move',{move:f('B').candidate});act(s,'reflect');assert(v(s).guidance.summary.some(r=>r.context.branch===v(s).selectedId&&r.context.stage==='candidate'&&r.texts[0]==='修正後的理由'));
});
test('sixteen archived revisions remain immutable while later drafts and navigation stay usable',()=>{
  const s=make('B');start(s,'B');const id=v(s).selectedId;
  for(let i=0;i<16;i++)write(s,'修訂 '+i);
  const archived=v(s).guidance.revisions;assert.throws(()=>write(s,'第十七次'),{code:'REVISION_LIMIT'});
  guide(s,'draft',{text:'上限後的目前草稿'});act(s,'root');act(s,'branch',{id});
  assert.equal(v(s).guidance.text,'上限後的目前草稿');assert.deepEqual(v(s).guidance.revisions,archived);
  act(s,'reflect');assert(v(s).guidance.summary.some(r=>r.texts.includes('上限後的目前草稿')));
  act(s,'reset');assert.equal(v(s).guidance.text,'');assert.deepEqual(v(s).guidance.revisions,[]);
});
