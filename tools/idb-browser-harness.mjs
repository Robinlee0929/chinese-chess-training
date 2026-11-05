import {variantSource} from './idb-test-variants.mjs';
import {migrationVariant} from './idb-migration-variants.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm, realpath, mkdir } from 'node:fs/promises';
import { createWriteStream, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
export const root = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(root,'..');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function deadline(promise, ms = 2000) { let timer; return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'DEADLINE_EXCEEDED', thresholdMs: ms }), ms); })]).finally(() => clearTimeout(timer)); }
export function fingerprint() {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean))].sort();
  const contents = files.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(path.join(repo, file))).digest('hex') }));
  return { head: git(['rev-parse','HEAD']), branch: git(['branch','--show-current']), status: git(['status','--porcelain=v1']), files: contents, fingerprint: createHash('sha256').update(JSON.stringify(contents)).digest('hex') };
}
export async function launch(label, {persistentContexts = false,pocSource='poc.js',bfcache=true,fixture='idb-browser-fixture.js',migrationMutation='',sourceRoot=repo,adapterRevision=null} = {}) {
  assert.match(fixture,/^[a-z0-9-]+\.js$/);
  if(adapterRevision!==null)assert.match(adapterRevision,/^[0-9a-f]{40}$/);
  const adapterText=adapterRevision===null?null:execFileSync('git',['show',adapterRevision+':custom-position-idb.js'],{cwd:repo,encoding:'utf8'});
  await mkdir(path.resolve(process.env.IDB_EVIDENCE_DIR || path.join(repo,'test-results/idb')),{recursive:true});
  let evidence = path.join(process.env.IDB_EVIDENCE_DIR || path.join(repo,'test-results/idb'), label);
  try { await mkdir(evidence, { recursive: false }); }
  catch(error) { if(error.code!=='EEXIST')throw error; evidence += '-'+Date.now(); await mkdir(evidence,{recursive:false}); }
  const baseline = fingerprint();
  await writeFile(path.join(evidence,'worktree-before.json'), JSON.stringify(baseline, null, 2));
  const journals=[],journalListeners=new Set(),journalStream=createWriteStream(path.join(evidence,'browser-journal.jsonl'));
  const server = createServer(async (req,res) => {
    const pathname = new URL(req.url,'http://localhost').pathname;
    if(pathname==='/journal'&&req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;try{const entry={externalTime:new Date().toISOString(),externalPerf:performance.now(),event:JSON.parse(body)};journals.push(entry);journalStream.write(JSON.stringify(entry)+'\n');for(const fn of journalListeners)fn(entry);}catch(error){journalStream.write(JSON.stringify({parseError:error.message})+'\n');}res.writeHead(204);res.end();return;}
    if (pathname === '/favicon.ico') { res.writeHead(204);res.end();return; }
    if(pathname==='/'||['/source','/far','/destination'].includes(pathname)){res.setHeader('Content-Type','text/html');res.end((await readFile(path.join(root,'idb-browser.html'),'utf8')).replace('/tools/idb-browser-fixture.js','/tools/'+fixture));return;}
    const sourceBase=pathname.startsWith('/tools/')?repo:path.resolve(sourceRoot);
    const file=path.resolve(sourceBase,'.'+pathname);if(!file.startsWith(sourceBase+path.sep)||!file.endsWith('.js')){res.writeHead(404);res.end();return;}
    try{let source=path.basename(file)==='custom-position-idb.js'&&adapterText!==null?adapterText:await readFile(file,'utf8');if(path.basename(file)==='custom-position-idb.js')source=variantSource(source,new URL(req.url,'http://localhost').searchParams.get('variant'));source=migrationVariant(source,migrationMutation,path.basename(file));res.setHeader('Content-Type','text/javascript');res.end(source);}catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = await mkdtemp(path.join(tmpdir(),'idb-stage0-chrome-'));
  const chromeArgs=['--headless=new','--remote-debugging-port=0','--no-first-run','--no-default-browser-check',...(bfcache?[]:['--disable-features=BackForwardCache']),`--user-data-dir=${profile}`,'about:blank'];
  const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',chromeArgs,{windowsHide:true,stdio:'ignore'});
  let endpoint;
  for(let i=0;i<100;i++){try{endpoint=await readFile(path.join(profile,'DevToolsActivePort'),'utf8');break;}catch{await sleep(50);}}
  assert.ok(endpoint,'Chrome debug endpoint');
  const [port,wsPath]=endpoint.trim().split(/\r?\n/);
  const socket=new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0; const pending=new Map(), events=[], observers=new Set();
  const raw=createWriteStream(path.join(evidence,'cdp-events.jsonl'));
  const commands=createWriteStream(path.join(evidence,'cdp-commands.jsonl'));
  socket.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);commands.write(JSON.stringify({type:'response',id:m.id,externalTime:new Date().toISOString(),externalPerf:performance.now(),method:p.method,error:m.error||null})+'\n');m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}return;}
    const event={externalTime:new Date().toISOString(),externalPerf:performance.now(),...m};
    if(m.method==='Runtime.bindingCalled'&&m.params.name==='trace') {try{event.trace=JSON.parse(m.params.payload);}catch{}}
    events.push(event);raw.write(JSON.stringify(event)+'\n');for(const fn of observers)fn(event);
  };
  function send(method,params={},sessionId) { const id=++seq;const loggedParams=method==='Runtime.evaluate'?{awaitPromise:params.awaitPromise,expressionPrefix:params.expression.slice(0,140),expressionBytes:Buffer.byteLength(params.expression),expressionSha256:createHash('sha256').update(params.expression).digest('hex')}:params;commands.write(JSON.stringify({type:'request',id,externalTime:new Date().toISOString(),externalPerf:performance.now(),method,sessionId,params:loggedParams})+'\n');return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,method});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}); }
  async function evaluate(tab,expression,awaitPromise=false) { const r=await send('Runtime.evaluate',{expression,awaitPromise,returnByValue:true},tab.sessionId||tab);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value; }
  function until(predicate,ms=2000,startIndex=0) {
    const found=events.slice(startIndex).find(predicate);if(found)return Promise.resolve(found);
    return new Promise(resolve=>{let timer;const fn=e=>{if(predicate(e)){clearTimeout(timer);observers.delete(fn);resolve(e);}};observers.add(fn);timer=setTimeout(()=>{observers.delete(fn);resolve({status:'DEADLINE_EXCEEDED',thresholdMs:ms});},ms);});
  }
  async function tab(context,url=origin+'/') {
    const {targetId}=await send('Target.createTarget',{url,background:true,browserContextId:context});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});const t={targetId,sessionId};
    await send('Page.enable',{},sessionId);await send('Runtime.enable',{},sessionId);await send('Runtime.addBinding',{name:'trace'},sessionId);
    for(let i=0;i<100;i++){try{if(await evaluate(t,'typeof window.poc !== "undefined"'))break;}catch{}await sleep(20);}
    if(url.startsWith(origin)) await evaluate(t,'ready',true);
    return t;
  }
  async function start(tab,input) { return evaluate(tab,`poc.mutate(${JSON.stringify(input)})`); }
  async function outcome(tab,id,ms=2000) { const result=await until(e=>e.sessionId===tab.sessionId&&e.trace?.type==='outcome'&&e.trace.operationId===id,ms);return result.trace||result; }
  async function write(tab,input,ms=2000) {
    const time=performance.now(),startedAt=new Date().toISOString();
    const result=await deadline((async()=>{await start(tab,input);return outcome(tab,input.operationId,ms);})(),ms);
    return {startedAt,elapsedMs:performance.now()-time,operation:input,result};
  }
  async function freeze(tab) {
    const eventStart=events.length,start=performance.now();
    await send('Page.setWebLifecycleState',{state:'frozen'},tab.sessionId);
    const event=await until(e=>e.sessionId===tab.sessionId&&e.trace?.type==='freeze',500,eventStart);
    const inspect=await evaluate(tab,'poc.inspect()');
    const id=randomUUID();await evaluate(tab,`poc.probe(${JSON.stringify(id)})`);
    const probe=await until(e=>e.sessionId===tab.sessionId&&e.trace?.type==='probe'&&e.trace.id===id,100,eventStart);
    return {commandAcknowledged:true,elapsedMs:performance.now()-start,freezeEvent:event.trace||null,probeDuringFreeze:probe.trace||null,inspect,probeId:id};
  }
  async function resume(tab) { await send('Page.setWebLifecycleState',{state:'active'},tab.sessionId);return evaluate(tab,'poc.inspect()'); }
  const version=await send('Browser.getVersion');
  await writeFile(path.join(evidence,'environment.json'),JSON.stringify({chrome:version,origin,profile,sourceRoot:path.resolve(sourceRoot),adapterRevision,headless:true,bfcacheRequested:bfcache,chromeArgs,storageContext:persistentContexts?'isolated profile default context (disk-backed)':'Target.createBrowserContext per case (off-the-record)',control:'Raw external Chrome CDP; no Playwright focus emulation',database:'chinese-chess-training:custom-positions',databaseVersion:1,store:'state',keys:['envelope','metadata']},null,2));
  async function save(name,value) {await writeFile(path.join(evidence,name+'.json'),JSON.stringify(value,null,2));}
  async function dispose(pair) {
    if(pair.context)return send('Target.disposeBrowserContext',{browserContextId:pair.context});
    for(const tab of [pair.a,pair.b])await send('Target.closeTarget',{targetId:tab.targetId}).catch(()=>{});
  }
  async function close() {
    const after=fingerprint();await save('worktree-after',after);assert.deepEqual(after,baseline,'Phase B worktree must remain byte-for-byte unchanged');
    await deadline(send('Browser.close'),3000).catch(()=>{});socket.close();
    await new Promise(resolve=>{if(chrome.exitCode!==null)resolve();else{chrome.once('exit',resolve);setTimeout(()=>{chrome.kill();resolve();},3000);}});
    await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>raw.end(resolve));await new Promise(resolve=>commands.end(resolve));await new Promise(resolve=>journalStream.end(resolve));
    const resolved=await realpath(profile),parent=await realpath(tmpdir());assert.equal(path.dirname(resolved).toLowerCase(),parent.toLowerCase());assert.ok(path.basename(resolved).startsWith('idb-stage0-chrome-'));await rm(resolved,{recursive:true,force:true,maxRetries:4,retryDelay:100}).catch(()=>{});
  }
  function waitJournal(predicate,ms=2000){const found=journals.find(predicate);if(found)return Promise.resolve(found);return new Promise(resolve=>{const fn=e=>{if(predicate(e)){clearTimeout(timer);journalListeners.delete(fn);resolve(e);}};journalListeners.add(fn);const timer=setTimeout(()=>{journalListeners.delete(fn);resolve({status:'DEADLINE_EXCEEDED'});},ms);});}
  return {root,evidence,origin,version,send,evaluate,until,events,tab,start,outcome,write,freeze,resume,save,dispose,close,journals,waitJournal};
}
