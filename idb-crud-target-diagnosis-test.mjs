import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {crudTargetProfile} from './tools/idb-crud-target-profile.mjs';
import {capacityFixture} from './tools/idb-capacity-fixture.mjs';
import {validateCustomPositionIDBState} from './custom-position-idb.js';
const source=readFileSync(new URL('./custom-position-idb.js',import.meta.url),'utf8');
const transformed=crudTargetProfile(source);
const moduleSource=transformed.replace(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL(p,import.meta.url).href}'`);
const instrumented=await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));

test('targeted transform preserves all transaction calls and scheduling sites',()=>{
  for(const word of ['await','setTimeout','setInterval','queueMicrotask','new Promise','tx.commit()','tx.abort()','store.get(','store.put(','validateReceipt(','applyCustomPositionOperation('])assert.equal(transformed.split(word).length,source.split(word).length,word);
});
test('128-receipt validation has only outer phase records, no per-receipt marks',()=>{
  const fixture=capacityFixture(98);globalThis.idbCrudCase='unit';globalThis.idbCrudMetrics.length=0;
  assert.deepEqual(instrumented.validateCustomPositionIDBState(fixture.envelope,fixture.metadata),validateCustomPositionIDBState(fixture.envelope,fixture.metadata));
  assert.deepEqual(globalThis.idbCrudMetrics.map(m=>m.phase),['V0-full-validation-start','V1-envelope-and-base-validated','T5-witness-replay-start','T5-witness-replay-end','T4-full-validation-end']);
  assert.equal(globalThis.idbCrudMetrics.filter(m=>m.name).length,0);globalThis.idbCrudCase=null;
});
test('diagnostic validation still rejects corrupt witness and preserves inputs',()=>{
  const fixture=capacityFixture(98);fixture.metadata.commits[0].delta.after.title='corrupt';const before=structuredClone(fixture);
  let original,observed;try{validateCustomPositionIDBState(fixture.envelope,fixture.metadata);}catch(e){original=e.code;}
  try{instrumented.validateCustomPositionIDBState(fixture.envelope,fixture.metadata);}catch(e){observed=e.code;}
  assert.ok(original);assert.equal(observed,original);assert.deepEqual(fixture,before);
});
test('historical 98-position fixture remains 129033 bytes with 128 witnesses',()=>{
  const fixture=capacityFixture(98);assert.equal(fixture.envelope.positions.length,98);assert.equal(fixture.metadata.commits.length,128);assert.equal(Buffer.byteLength(JSON.stringify(fixture.envelope)),129033);
});
