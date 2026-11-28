import { createSandbox } from './model.mjs';
import { createBrowserCoach } from '../thinking-coach-browser/browser-coach.mjs';
import { teaching } from './teaching-adapter.mjs';

// The unchanged sandbox/core remain authoritative. Only primitive JSON crosses APIs.
export function createGuidedSandbox(sourceText) {
  const base = createSandbox(sourceText); // Validates JSON-only before any reflection.
  let original = sourceText, epoch = 0, generation = 0, ticket = 0, serial = 0, closed = false;
  let records = new Map(), explored = new Map(), level = 1, disclosure = null, verifying = false;
  let target = { candidates:2, plies:3 };
  const fail = code => { throw Object.assign(new Error(code),{code}); };
  const state = () => JSON.parse(base.view());
  function context(v) { return { session:v.token.key, epoch, branch:v.selectedId, node:v.visited.find(n=>n.selected)?.id??null, stage:v.teaching.stage }; }
  const key = c => JSON.stringify(c);
  const current = v => records.get(key(context(v)));
  function route(v) {
    const moves=[];let node=v.visited.find(n=>n.selected);
    while(node){moves.unshift(node.move);node=v.visited.find(n=>n.id===node.parentId);}
    return moves;
  }
  function command(text,allowed) {
    if(typeof text!=='string'||text.length>4096)fail('JSON_TEXT_REQUIRED');
    const c=JSON.parse(text);
    if(!c||Array.isArray(c)||!allowed.includes(c.type))fail('INVALID_COMMAND');
    if(closed)fail('SESSION_DESTROYED');
    const token=state().token;
    if(c.token?.key!==token.key||c.token?.version!==token.version)fail('STALE_VIEW');
    if(Object.keys(c.token).some(k=>!['key','version'].includes(k)))fail('INVALID_COMMAND');
    const fields={write:['text'],draft:['text'],forecast:['move','expect'],expect:['expect'],hint:['level'],target:['candidates','plies'],verifyPrediction:[]}[c.type];
    if(Object.keys(c).some(k=>!['type','token',...fields].includes(k)))fail('INVALID_COMMAND');
    return c;
  }
  function record(v) {
    const c=context(v),k=key(c);
    if(!records.has(k)){if(records.size>=1024)fail('RECORD_LIMIT');records.set(k,{context:c,kind:'UNPROVEN_HYPOTHESIS',texts:[],predictions:[]});}
    return records.get(k);
  }
  function refresh(v) { if(v.selectedId)explored.set(v.selectedId,v.visited); }
  function project() {
    if(closed)fail('SESSION_DESTROYED');
    const v=state(),r=current(v),prediction=r?.predictions.at(-1)??null;
    const prompt=JSON.parse(teaching(JSON.stringify({stage:v.teaching.stage,level,hasRecord:!!r?.texts.length,hasPrediction:!!prediction,mismatch:r?.lastCheck?.predictionId===prediction?.id&&r?.lastCheck?.mismatch===true})));
    const summary=v.teaching.stage==='reflect' ? [...records.values()].map(r=>({context:r.context,kind:r.kind,texts:[...r.texts,...(r.draftText!==undefined&&r.draftText!==r.texts.at(-1)?[r.draftText]:[])],predictions:r.predictions.map(p=>({id:p.id,move:p.move,expect:p.expect,kind:p.kind}))})) : [];
    return {...v,guidance:{context:context(v),canRecord:!!r||records.size<1024,prompt,target,depth:route(v).length,text:r?.draftText??r?.texts.at(-1)??'',savedText:r?.texts.at(-1)??'',revisions:r?.texts??[],prediction,expect:r?.draftExpect??prediction?.expect??{check:'unsure',capture:'unsure',recapture:'unsure'},disclosure,summary,
      explored:v.teaching.stage==='reflect'?[...explored].map(([branch,nodes])=>({branch,nodes})):[]}};
  }
  function invalidate() { generation++;ticket++;disclosure=null;level=1; }
  function act(text) {
    const before=state();
    const v=JSON.parse(base.act(text)); // Validates token, coordinates and legality atomically.
    const c=JSON.parse(text);
    invalidate();
    if(c.type==='reset'){epoch++;records.clear();explored.clear();}
    if(c.type==='move'&&before.rootMode){const reason=current(before)?.draftText??current(before)?.texts.at(-1);if(reason){
      const reasonContext={...context(v),node:v.visited[0].id,stage:'candidate'};
      // At capacity the original root reason remains available in reflection.
      if(records.size<1024)records.set(key(reasonContext),{context:reasonContext,kind:'UNPROVEN_HYPOTHESIS',texts:[reason],predictions:[]});
    }}
    refresh(v);return JSON.stringify(project());
  }
  function guide(text) {
    const c=command(text,['write','draft','forecast','expect','hint','target']),v=state();
    if(['write','draft'].includes(c.type)&&(typeof c.text!=='string'||c.text.length>300))fail('INVALID_TEXT');
    if(c.type==='forecast'){
      if(v.rootMode)fail('CANDIDATE_REQUIRED');
      const m=c.move;
      if(!m||Array.isArray(m)||Object.keys(m).sort().join()!=='from,to')fail('INVALID_MOVE');
      for(const p of [m.from,m.to])if(!p||Array.isArray(p)||Object.keys(p).sort().join()!=='c,r'||!Number.isInteger(p.r)||!Number.isInteger(p.c)||p.r<0||p.r>9||p.c<0||p.c>8)fail('INVALID_MOVE');
      if((current(v)?.predictions.length??0)>=16)fail('PREDICTION_LIMIT');
    }
    if(['forecast','expect'].includes(c.type)&&(!c.expect||Array.isArray(c.expect)||Object.keys(c.expect).sort().join()!=='capture,check,recapture'||Object.values(c.expect).some(x=>!['yes','no','unsure'].includes(x))))fail('INVALID_EXPECTATION');
    if(c.type==='hint'&&![1,2,3].includes(c.level))fail('INVALID_LEVEL');
    if(c.type==='target'&&(!Number.isInteger(c.candidates)||c.candidates<1||c.candidates>3||!Number.isInteger(c.plies)||c.plies<1||c.plies>5))fail('INVALID_TARGET');
    if(['write','draft','forecast','expect'].includes(c.type)&&!current(v)&&records.size>=1024)fail('RECORD_LIMIT');
    if(c.type==='write'&&(current(v)?.texts.length??0)>=16)fail('REVISION_LIMIT');
    base.act(JSON.stringify({type:'clearFacts',token:v.token}));invalidate();
    if(c.type==='write')record(v).texts.push(c.text);
    if(['write','draft'].includes(c.type))record(v).draftText=c.text;
    if(c.type==='forecast')record(v).predictions.push({id:++serial,kind:'UNPROVEN_HYPOTHESIS',move:c.move,expect:c.expect});
    if(['forecast','expect'].includes(c.type))record(v).draftExpect=c.expect;
    if(c.type==='hint')level=c.level;
    if(c.type==='target')target={candidates:c.candidates,plies:c.plies};
    return JSON.stringify(project());
  }
  function inspect(v,prediction) {
    const probe=createBrowserCoach(original),run=(op,extra={})=>JSON.parse(probe.dispatch(JSON.stringify({op,...extra})));
    try {
      run('observe');const moves=route(v);for(const[i,move]of moves.entries())run(i===0?'addCandidate':'play',{move});
      try { run(moves.length?'play':'addCandidate',{move:prediction.move}); }
      catch(e){if(!['ILLEGAL_MOVE','TERMINAL_POSITION'].includes(e.code))throw e;return {kind:'CANONICAL_FACT',legal:false,scope:'submitted-move-only',continuationProved:false};}
      const f=run('nodeFacts'),recapture=run('checkNoImmediateRecapture');
      return {kind:'CANONICAL_FACT',legal:true,check:f.checked,capture:f.capture!==null,recapture:recapture.verdict==='REFUTED',
        scope:'submitted-move-and-immediate-recapture-only',history:f.historyAdjudication,continuationProved:false};
    } finally { probe.destroy(); }
  }
  async function verifyPrediction(text) {
    command(text,['verifyPrediction']);const v=state(),p=current(v)?.predictions.at(-1);
    if(!p)fail('PREDICTION_REQUIRED');
    if(verifying)return JSON.stringify({accepted:false,reason:'CHECK_PENDING'});
    verifying=true;
    try {
    const g=generation,t=++ticket,facts=inspect(v,p);
    await new Promise(resolve=>setTimeout(resolve,0));
    if(closed||g!==generation||t!==ticket)return JSON.stringify({accepted:false,reason:'STALE_VIEW'});
    base.act(JSON.stringify({type:'clearFacts',token:v.token}));generation++;ticket++;
    const mismatch=!facts.legal||['check','capture','recapture'].some(k=>p.expect[k]!=='unsure'&&(p.expect[k]==='yes')!==facts[k]);
    disclosure={predictionId:p.id,facts,mismatch};level=3;
    record(v).lastCheck=disclosure;
    return JSON.stringify({accepted:true,view:project()});
    } finally { verifying=false; }
  }
  async function check(text) {
    if(typeof text!=='string'||text.length>4096)fail('JSON_TEXT_REQUIRED');
    if(verifying)return JSON.stringify({accepted:false,reason:'CHECK_PENDING'});
    verifying=true;
    try {
    const g=generation,t=++ticket,result=JSON.parse(await base.check(text));
    if(closed||g!==generation||t!==ticket||!result.accepted)return JSON.stringify({accepted:false,reason:'STALE_VIEW'});
    generation++;ticket++;disclosure=null;return JSON.stringify({accepted:true,view:project()});
    } finally { verifying=false; }
  }
  return Object.freeze({view:()=>JSON.stringify(project()),act,guide,check,verifyPrediction,
    destroy(){closed=true;generation++;ticket++;records.clear();explored.clear();original='';base.destroy();}});
}
