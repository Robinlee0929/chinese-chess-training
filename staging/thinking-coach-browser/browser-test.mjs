// Isolated full Chrome contexts, loopback only, synthetic data. Output must be outside checkout.
// node staging/thinking-coach-browser/browser-test.mjs OUT
// PLAYWRIGHT_MODULE may point to an existing Playwright install. No package install required.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { fixtures, expected, vectors } from './test-data.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=path.resolve(process.argv[2]);
assert(out!==path.resolve(root)&&!out.startsWith(path.resolve(root)+path.sep));fs.mkdirSync(out,{recursive:false});
const prefix='/staging/thinking-coach-browser/',entry=fs.readFileSync(new URL('./browser-coach.mjs',import.meta.url),'utf8');
const mutations=[
  {name:'fingerprint-corruption',oracle:'fingerprint-parity',from:'return sha256Text(stable(value));',to:"return '0'.repeat(64);"},
  {name:'reflect-untrusted-object',oracle:'reject-object-before-reflection',from:"requireCondition(typeof text === 'string', 'JSON_TEXT_REQUIRED');",to:"if(typeof text !== 'string') JSON.stringify(text); requireCondition(typeof text === 'string', 'JSON_TEXT_REQUIRED');"},
  {name:'duplicate-key',oracle:'duplicate-key',from:"requireCondition(!keys.has(key), 'DUPLICATE_KEY');",to:"requireCondition(true, 'DUPLICATE_KEY');"},
  {name:'deep-json',oracle:'depth-limit',from:"depth <= 16 && --remaining >= 0",to:"depth <= 100 && --remaining >= 0"},
  {name:'large-json',oracle:'size-limit',from:"text.length <= 262144 && new TextEncoder().encode(text).length <= 262144",to:'true'},
  {name:'piece-fields',oracle:'field-whitelist',from:"exact(piece, ['type', 'side']);",to:'// mutant removes piece whitelist'},
  {name:'cross-session-token',oracle:'cross-session-ticket',from:'const uuid = () => globalThis.crypto.randomUUID();',to:"const uuid = () => 'shared-ticket';"},
  {name:'reset-stale-result',oracle:'stale-result',from:'if (!active || ticket !== pending || !pending) return freeze({ accepted: false, reason: \'STALE_RESULT\' });',to:'return freeze({ accepted:true });'},
  {name:'duplicate-result',oracle:'one-shot-ticket',from:"if (!pending || command.ticket !== pending.handle) return encode({ accepted:false, reason:'STALE_RESULT' });",to:"if (!pending) return encode({accepted:true}); if(command.ticket !== pending.handle) return encode({accepted:false});"},
  {name:'missing-defense',oracle:'reply-completeness',from:"requireCondition(stable(received) === stable(expected), 'REPLIES_MISMATCH');",to:"requireCondition(true, 'REPLIES_MISMATCH');"},
  {name:'illegal-candidate',oracle:'illegal-move',from:"requireCondition(current.legalMoves.some(candidate => sameMove(candidate, move)), 'ILLEGAL_MOVE');",to:"requireCondition(true, 'ILLEGAL_MOVE');"},
  {name:'answer-leak',oracle:'teaching-projection',from:'return freeze({ stage, question: QUESTIONS[stage],',to:'return freeze({ answer: branches[0]?.candidate, stage, question: QUESTIONS[stage],'},
  {name:'hypothesis-proof',oracle:'evidence-label',from:'kind: EVIDENCE_KIND.HYPOTHESIS,\n        text, proved: false,',to:'kind: EVIDENCE_KIND.FACT,\n        text, proved: true,'},
  {name:'storage-write',oracle:'no-storage',from:'identifier(sessionId);',to:"identifier(sessionId); globalThis.localStorage.setItem('coach','leak');"},
];
const mutated=new Map();for(const mutation of mutations){assert.equal(entry.split(mutation.from).length-1,1,mutation.name+' exact mutation site');mutated.set(mutation.name,entry.replace(mutation.from,mutation.to));}
const server=createServer((req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');let body,type='text/javascript';
    if(u.pathname==='/') {body='<!doctype html><meta charset="utf-8"><title>Coach isolated module tests</title>';type='text/html';}
    else if(u.pathname===prefix+'mutant.mjs'){assert(mutated.has(u.searchParams.get('case')));body=mutated.get(u.searchParams.get('case'));}
    else{const file=path.resolve(root,'.'+decodeURIComponent(u.pathname));assert(file.startsWith(path.resolve(root)+path.sep));assert(['.js','.mjs','.json'].includes(path.extname(file)));body=fs.readFileSync(file);if(file.endsWith('.json'))type='application/json';}
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const report={status:'RUNNING',browser:browser.version(),channel:'chrome',base,startedUTC:new Date().toISOString(),sourceSHA256:createHash('sha256').update(entry).digest('hex'),positive:[],negative:[],errors:[],contexts:0,requests:[]};
async function context(){
  report.contexts++;const ctx=await browser.newContext();
  await ctx.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await ctx.newPage();page.on('request',r=>report.requests.push(r.url()));
  await page.goto(base);await page.evaluate(()=>{
    localStorage.setItem('synthetic-preserved','sentinel');
    globalThis.__writes=[];
    for(const key of ['setItem','removeItem','clear'])Storage.prototype[key]=function(){__writes.push('storage.'+key);throw new Error('STORAGE_WRITE_DETECTED');};
    for(const key of ['open','deleteDatabase'])IDBFactory.prototype[key]=function(){__writes.push('idb.'+key);throw new Error('STORAGE_WRITE_DETECTED');};
  });return {ctx,page};
}
try{
  const {ctx,page}=await context();
  // Module loading is outside all negative-control catches.
  report.positive=await page.evaluate(async({fixtures,expected,vectors,prefix})=>{
    const m=await import(prefix+'browser-coach.mjs'),checks=await import(prefix+'browser-checks.mjs'),hash=await import(prefix+'sha256.mjs');
    const rows=checks.runChecks(m,fixtures,expected);
    for(const vector of vectors){const bytes=new TextEncoder().encode(vector.text);const native=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
      if(native!==vector.sha256||hash.sha256Text(vector.text)!==native)throw new checks.OracleFailure('SHA256 differential failed');}
    rows.push({name:'SHA256 Node / pure JS / Chrome WebCrypto '+vectors.length+' vectors',status:'PASS'});
    if(__writes.length||localStorage.getItem('synthetic-preserved')!=='sentinel')throw new checks.OracleFailure('storage changed');
    rows.push({name:'no localStorage or IndexedDB writes; sentinel unchanged',status:'PASS'});return rows;
  },{fixtures,expected,vectors,prefix});
  await ctx.close();console.log(JSON.stringify({positive:report.positive.length,status:'PASS'}));
  for(const mutation of mutations){
    const {ctx,page}=await context();
    const loaded=await page.evaluate(async({prefix,name})=>{
      globalThis.__module=await import(prefix+'mutant.mjs?case='+name);globalThis.__checks=await import(prefix+'browser-checks.mjs');return Object.keys(__module).sort();
    },{prefix,name:mutation.name});assert.deepEqual(loaded,['createBrowserCoach','fingerprintJSON']);
    const row=await page.evaluate(({name,oracle,fixtures})=>{
      let detected=false,reason=null;
      try{__checks.securityOracles[oracle](__module,fixtures);}catch(e){reason=e.message;detected=e.name==='OracleFailure'||(name==='storage-write'&&e.message==='STORAGE_WRITE_DETECTED'&&__writes.length>0);}
      return {name,oracle,importSucceeded:true,detected,reason,writes:__writes};
    },{name:mutation.name,oracle:mutation.oracle,fixtures});
    report.negative.push(row);fs.writeFileSync(out+'/results.json',JSON.stringify(report,null,2));await ctx.close();assert(row.detected,mutation.name+' did not trigger a behavioral oracle');console.log(JSON.stringify(row));
  }
  assert(report.requests.every(u=>new URL(u).origin===base));assert(!report.requests.some(u=>u.includes('node:')));report.status='PASS';
}catch(e){report.status='FAIL';report.errors.push(e.stack);process.exitCode=1;}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));report.finishedUTC=new Date().toISOString();fs.writeFileSync(out+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,positive:report.positive.length,negative:report.negative.filter(x=>x.detected).length,errors:report.errors}));}
