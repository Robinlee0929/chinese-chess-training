import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performanceGate,performanceDistribution} from './tools/idb-performance-gate.mjs';
import {performanceProfile} from './tools/idb-performance-profile.mjs';
const observed=totalMs=>({totalMs,native:{trace:{terminal:'COMPLETE',trusted:true}},outcome:{status:'COMMITTED'}});
test('historical 2122.5354 ms native commit remains a failed end-to-end gate',()=>{assert.equal(performanceGate(observed(2122.5354)),false);assert.equal(performanceGate({...observed(2122.5354),writeMs:1244.6226}),false);});
test('2000 ms is not relaxed and timing cannot be NaN or negative',()=>{for(const ms of [2000,Infinity,NaN,-1])assert.equal(performanceGate(observed(ms)),false);assert.equal(performanceGate(observed(1999.9)),true);assert.equal(performanceGate(observed(2122.5354),3000),false);});
test('conflict, abort and request success cannot satisfy the commit gate',()=>{for(const status of ['REVISION_CONFLICT','UNKNOWN','ABORTED_OBSERVED'])assert.equal(performanceGate({...observed(10),outcome:{status}}),false);assert.equal(performanceGate({...observed(10),native:{trace:{terminal:'REQUEST_SUCCESS',trusted:true}}}),false);assert.equal(performanceGate({...observed(10),native:{trace:{terminal:'COMPLETE',trusted:false}}}),false);});
test('distribution preserves a slow valid sample even when the median passes',()=>{const samples=[{id:'fast1',totalMs:1000,pass:true},{id:'slow',totalMs:2122.5354,pass:false},{id:'fast2',totalMs:1100,pass:true}],d=performanceDistribution(samples);assert.equal(d.median,1100);assert.equal(d.maximum,2122.5354);assert.deepEqual(d.values,[1000,2122.5354,1100]);assert.deepEqual(d.failures,['slow']);assert.equal(performanceDistribution([samples[0],samples[2]]).median,1050);});
test('synchronous profile preserves await and scheduling sites',()=>{const source=readFileSync(new URL('./custom-position-idb.js',import.meta.url),'utf8'),profile=performanceProfile(source);for(const word of ['await','setTimeout','setInterval','queueMicrotask','new Promise'])assert.equal(profile.split(word).length,source.split(word).length,word);assert.match(profile,/full-state-validation/);assert.match(profile,/metadata-read-delivered/);});
test('even six-byte JSON escapes and 90 occupied cells cannot approach a legal 1 MiB envelope',()=>{
  // Deliberate overestimate, not a legal board: 90 cells exceed piece limits.
  // A UTF-16 unit/code point needs at most six serialized bytes (\\uXXXX).
  const record={id:'\ud800'.repeat(128),title:'\ud800'.repeat(60),initialBoard:Array.from({length:10},()=>Array.from({length:9},()=>({type:'K',side:'black'}))),sideToMove:'black',createdAt:'9999-12-31T23:59:59.999Z',updatedAt:'9999-12-31T23:59:59.999Z',playPreferences:{humanSide:'black',difficulty:'medium'}};
  const upper={version:1,revision:Number.MAX_SAFE_INTEGER,positions:Array(100).fill(record)};
  assert.ok(Buffer.byteLength(JSON.stringify(upper))<1024*1024);
});
