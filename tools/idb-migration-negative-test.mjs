import assert from 'node:assert/strict';
import {launch} from './idb-browser-harness.mjs';
import {capacityFixture} from './idb-capacity-fixture.mjs';
const legacy=JSON.stringify(capacityFixture(10).envelope),changed=legacy.replace('test 1','source changed');
for(const mutation of ['ignore-legacy','early-active','overwrite-active','ignore-fingerprint']){
 const h=await launch('migration-negative-'+mutation,{persistentContexts:true,fixture:'idb-migration-fixture.js',migrationMutation:mutation});
 const ev=(t,s)=>h.evaluate(t,s,true);
 try{
  const a=await h.tab();await ev(a,'poc.reset()');await ev(a,`poc.legacy(${JSON.stringify(legacy)})`);const b=await h.tab();let result,before,after,detected;
  if(mutation==='ignore-legacy'){
   result=await ev(a,'poc.manager.initialize()');after=await ev(b,'poc.raw()');
   assert.equal(result.state,'ACTIVE');assert.equal(after.envelope.positions.length,0);
   assert.throws(()=>assert.equal(result.state,'MIGRATION_REQUIRED'),{code:'ERR_ASSERTION'});detected='Valid legacy ignored; empty ACTIVE DB created.';
  }else{
   await ev(a,'poc.plan()');
   if(mutation==='early-active'){
    await ev(a,"poc.faults({writeFault:'abort'})");const from=h.events.length;result=await ev(a,'poc.confirm()');
    assert.equal(result.state,'ACTIVE');const abort=await h.until(e=>e.sessionId===a.sessionId&&e.trace?.type==='native-terminal'&&e.trace.terminal==='ABORT',3000,from);assert.equal(abort.trace?.trusted,true);
    after=await ev(b,'poc.raw()');assert.deepEqual(after,{envelope:null,metadata:null});
    assert.throws(()=>assert.equal(after.metadata?.migration.state,'ACTIVE'),{code:'ERR_ASSERTION'});detected='False ACTIVE despite native ABORT and no durable data.';
   }else if(mutation==='overwrite-active'){
    assert.equal((await ev(a,'poc.confirm()')).state,'ACTIVE');
    result=await ev(b,"(async()=>{const s=(await poc.adapter.read()).snapshot;return poc.adapter.write(poc.adapter.prepare(s,{type:'rename',id:'seed-1',title:'new active edit'}))})()");assert.equal(result.status,'COMMITTED');before=await ev(b,'poc.raw()');
    // Simulate a resumed callback retaining the old confirmation plan.
    await ev(a,"poc.manager.suspend('test-interruption');poc.manager.resume()");result=await ev(a,'poc.confirm()');after=await ev(b,'poc.raw()');
    assert.equal(result.state,'ACTIVE');assert.equal(after.envelope.revision,130);assert.equal(before.envelope.revision,131);
    assert.throws(()=>assert.deepEqual(after.envelope,before.envelope),{code:'ERR_ASSERTION'});detected='Stale recovery replaced a newer ACTIVE envelope.';
   }else{
    await ev(b,`poc.legacy(${JSON.stringify(changed)})`);result=await ev(a,'poc.confirm()');after=await ev(b,'poc.raw()');
    assert.equal(result.state,'ACTIVE');assert.deepEqual(after.envelope,JSON.parse(legacy));assert.equal(await ev(b,'poc.legacyRaw()'),changed);
    assert.throws(()=>assert.equal(result.code,'SOURCE_CHANGED'),{code:'ERR_ASSERTION'});detected='Changed source accepted; obsolete candidate activated.';
   }
  }
  await h.save('detected',{mutation,result,before,after,detected});console.log(mutation+' DETECTED');await h.dispose({a,b});
 }catch(error){await h.save('failure',{message:error.message,stack:error.stack});throw error;}
 finally{await h.save('console-errors',h.events.filter(e=>e.method==='Runtime.exceptionThrown'||['page-error','unhandled-rejection'].includes(e.trace?.type)));await h.close();}
}
