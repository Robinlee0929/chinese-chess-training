import assert from 'node:assert/strict';
import {launch} from './idb-browser-harness.mjs';
const h=await launch('adapter-concurrency',{persistentContexts:true}),summary=[];
const read=async t=>{const r=await h.evaluate(t,'poc.read()',true);assert.equal(r.ok,true);return r.snapshot;};
const prepare=(t,c)=>h.evaluate(t,`poc.prepare(${JSON.stringify(c)})`,true);
try{
 for(const sameTab of [true,false]){
  const a=await h.tab(undefined,h.origin+'/?tab=A'),b=await h.tab(undefined,h.origin+'/?tab=B');await h.evaluate(a,'poc.seed(1)',true);const tabs=[a,sameTab?a:b],rounds=[];
  for(let round=0;round<2;round++){
   let ids=[];
   for(const type of ['save','rename','preferences','delete']){
    const before=await read(a),commands=type==='save'?await h.evaluate(a,`[1,2].map(i=>({type:'save',position:poc.position(i)}))`):ids.map((id,i)=>type==='rename'?{type,id,title:'name '+round+' '+i}:type==='preferences'?{type,id,preferences:{humanSide:i?'black':'red',difficulty:i?'hard':'easy'}}:{type,id});
    const tokens=await Promise.all(tabs.map((t,i)=>prepare(t,commands[i]))),writes=await Promise.all(tabs.map((t,i)=>h.write(t,tokens[i])));assert.deepEqual(writes.map(w=>w.result.status).sort(),['COMMITTED','REVISION_CONFLICT']);const loser=writes.findIndex(w=>w.result.status==='REVISION_CONFLICT'),winner=1-loser;
    const retry=await prepare(tabs[loser],commands[loser]),retried=await h.write(tabs[loser],retry);assert.equal(retried.result.status,'COMMITTED');const final=await read(b);assert.deepEqual(final,await read(a));assert.equal(final.envelope.revision,before.envelope.revision+2);assert.deepEqual(final.metadata.committedOperationIds.slice(-2),[tokens[winner].operationId,retry.operationId]);assert.ok(!final.metadata.committedOperationIds.includes(tokens[loser].operationId));
    if(type==='save')ids=final.envelope.positions.filter(p=>p.id!=='seed-0').map(p=>p.id);
    if(type==='rename')for(let i=0;i<2;i++)assert.equal(final.envelope.positions.find(p=>p.id===ids[i]).title,commands[i].title);
    if(type==='preferences')for(let i=0;i<2;i++)assert.deepEqual(final.envelope.positions.find(p=>p.id===ids[i]).playPreferences,commands[i].preferences);
    if(type==='delete')assert.equal(final.envelope.positions.length,1);
    const evidence={sameTab,round,type,before,commands,tokens,writes,retry,retried,final};await h.save((sameTab?'same':'cross')+'-'+round+'-'+type,evidence);rounds.push({type,revision:final.envelope.revision,maxMs:Math.max(...writes.map(w=>w.elapsedMs),retried.elapsedMs)});
   }
  }
  summary.push({id:sameTab?'same-tab-CRUD':'cross-tab-CRUD',result:'PASS',commits:16,conflicts:8,rounds});console.log(JSON.stringify(summary.at(-1)));await h.dispose({a,b});
 }
 {const a=await h.tab(undefined,h.origin+'/?tab=A'),b=await h.tab(undefined,h.origin+'/?tab=B');await h.evaluate(a,'poc.seed(1)',true);const before=await read(a),token=await prepare(a,{type:'rename',id:'seed-0',title:'unique'});assert.equal((await h.write(a,token)).result.status,'COMMITTED');
  const duplicate=await h.evaluate(b,`(async()=>{const t=${JSON.stringify(token)},s=${JSON.stringify(before)},a=poc.api.createCustomPositionIDB({now:()=>t.preparedAt,randomUUID:()=>t.positionId});const op=a.prepare(s,t.command,{nonce:t.operationId.split('/').at(-1)});const r=await a.write(op);a.dispose();return r;})()`,true);assert.equal(duplicate.code,'DUPLICATE_OPERATION');
  const collision=await h.evaluate(b,`(async()=>{const t=${JSON.stringify(token)},s=${JSON.stringify(before)},a=poc.api.createCustomPositionIDB({now:()=>t.preparedAt,randomUUID:()=>t.positionId});const op=a.prepare(s,{...t.command,title:'collision'},{nonce:t.operationId.split('/').at(-1)});const r=await a.write(op);a.dispose();return r;})()`,true);assert.equal(collision.code,'OPERATION_ID_COLLISION');const after=await read(b);assert.equal(after.envelope.revision,1);await h.save('operation-ids',{token,duplicate,collision,after});summary.push({id:'operation-ids',result:'PASS'});await h.dispose({a,b});}
 await h.save('summary',summary);
}catch(error){await h.save('harness-failure',{message:error.message,stack:error.stack,summary});throw error;}
finally{await h.save('console-errors',h.events.filter(e=>e.method==='Runtime.exceptionThrown'||['page-error','unhandled-rejection'].includes(e.trace?.type)));await h.close();}
