// Local, isolated Chrome only. Does not load or change the production UI.
// PLAYWRIGHT_MODULE=... node tools/game-transfer-performance.mjs OUTSIDE_REPO_DIR
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {longGame,longCompletedGame,terminal} from './game-transfer-fixtures.mjs';
import {serializeGameTransfer,GAME_TRANSFER_MAX_BYTES} from '../game-transfer/game-transfer.js';
const root=await realpath(fileURLToPath(new URL('..',import.meta.url)));
assert.ok(process.argv[2],'Provide a new evidence directory outside the checkout');
const out=path.resolve(process.argv[2]);
const parent=await realpath(path.dirname(out));
assert.ok(parent!==root&&!parent.startsWith(root+path.sep),'Evidence must stay outside the checkout');
await mkdir(out,{recursive:false});
const fixtures=[['standard-red-1024',longGame(1024,'red',true)],['custom-black-1024',longGame(1024,'black')],
  ['completed-black-1024',longCompletedGame()],['completed-capture',terminal()]].map(([name,game])=>{
    const canonical=serializeGameTransfer(game);
    return {name,plies:game.moves.length,text:canonical+' '.repeat(GAME_TRANSFER_MAX_BYTES-Buffer.byteLength(canonical)),status:game.status};
  });
const requests=[],errors=[],results=[];
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');requests.push(url.pathname);
    if(url.pathname==='/chinese-chess-training/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Isolated transfer Worker benchmark</title><p>Worker responsiveness probe</p>');return;
    }
    const rel=decodeURIComponent(url.pathname.replace(/^\/chinese-chess-training\//,''));
    assert.ok(url.pathname.startsWith('/chinese-chess-training/')&&rel.endsWith('.js'));
    const target=path.resolve(root,rel);assert.ok(target.startsWith(root+path.sep));
    const body=await readFile(target);res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {channel:'chrome'})});
  for(const [viewport,cpuRate] of [[{width:1440,height:1000},1],[{width:390,height:844},4]]){
    const context=await browser.newContext({viewport});assert.deepEqual(await context.storageState(),{cookies:[],origins:[]});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    const cdp=await context.newCDPSession(page), mainScripts=new Set();
    cdp.on('Debugger.scriptParsed',event=>{if(event.url)mainScripts.add(event.url);});
    await cdp.send('Debugger.enable');
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/chinese-chess-training/`);
    if(cpuRate!==1)await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
    await page.evaluate(async()=>{
      window.clientModule=await import('./game-transfer/worker-client.js');
    });
    for(const fixture of fixtures){
      const timings=[];
      for(let trial=0;trial<3;trial++){
        const result=await page.evaluate(async({text})=>{
          const protocolDurations=[];
          class TimedWorker {
            constructor(url,options){this.worker=new Worker(url,options);}
            set onmessage(callback){this.worker.onmessage=callback?event=>{
              const at=performance.now();
              try{callback(event);}finally{protocolDurations.push(performance.now()-at);}
            }:null;}
            set onerror(callback){this.worker.onerror=callback;}
            set onmessageerror(callback){this.worker.onmessageerror=callback;}
            postMessage(message){this.worker.postMessage(message);}
            terminate(){this.worker.terminate();}
          }
          const client=clientModule.createGameTransferValidationClient({WorkerClass:TimedWorker});
          const source=new TextEncoder().encode(text), originalBytes=source.byteLength;
          const gaps=[];let prior=performance.now(),ticks=0;
          const heartbeat=setInterval(()=>{const t=performance.now();gaps.push(t-prior);prior=t;ticks++;},10);
          const start=performance.now();
          try{
            const value=await client.validate(source);
            // Include the final task: clearing the interval immediately after a
            // reply otherwise hides synchronous protocol work from heartbeat gaps.
            return {elapsedMs:performance.now()-start,ticks,maxHeartbeatGapMs:Math.max(performance.now()-prior,...gaps),protocolMs:Math.max(0,...protocolDurations),bytes:source.byteLength,originalBytes,
              plies:value.replay.totalPlies,status:value.document.status,mode:value.document.mode,terminal:value.replay.terminal,
              frozen:Object.isFrozen(value.document.moves),storageKeys:Object.keys(localStorage),mainModules:performance.getEntriesByType('resource').filter(r=>r.initiatorType==='script').map(r=>r.name)};
          }finally{clearInterval(heartbeat);client.dispose();}
        },fixture);
        assert.equal(result.bytes,GAME_TRANSFER_MAX_BYTES);assert.equal(result.originalBytes,result.bytes);
        assert.equal(result.plies,fixture.plies);assert.equal(result.status,fixture.status);assert.equal(result.frozen,true);
        assert.deepEqual(result.storageKeys,[]);assert.ok(result.elapsedMs<10000);assert.ok(result.ticks>0);
        result.mainExecutionScripts=[...mainScripts];
        // Resource Timing can report Worker fetches; use the page debugger's
        // execution target, not network initiator labels, to prove isolation.
        assert.ok(result.mainExecutionScripts.every(u=>!['/game-record.js','/game-transfer/game-transfer.js','/game.js','/game-transfer/strict-json.js'].some(p=>u.includes(p))),'chess and strict import validation stay off main execution target');
        timings.push(result);
      }
      const row={viewport,cpuRate,fixture:fixture.name,timings};results.push(row);
      console.log(JSON.stringify({viewport:viewport.width,cpuRate,fixture:fixture.name,ms:timings.map(x=>Math.round(x.elapsedMs)),maxHeartbeatGapMs:Math.max(...timings.map(x=>x.maxHeartbeatGapMs))}));
    }
    const lifecycle=await page.evaluate(async text=>{
      const client=clientModule.createGameTransferValidationClient(),p=client.validate(text);client.cancel();
      let cancelCode;try{await p;}catch(e){cancelCode=e.code;}
      const recovered=await client.validate(text);client.dispose();
      return {cancelCode,recoveredPlies:recovered.replay.totalPlies,databases:(await indexedDB.databases()).map(d=>d.name)};
    },fixtures[0].text);
    assert.equal(lifecycle.cancelCode,'CANCELLED');assert.equal(lifecycle.recoveredPlies,1024);assert.deepEqual(lifecycle.databases,[]);
    results.push({viewport,cpuRate,lifecycle});
    if(cpuRate===1){
      const timeoutProbe=await page.evaluate(async text=>{
        const workerURL=URL.createObjectURL(new Blob(['self.onmessage = () => {};'],{type:'text/javascript'}));
        const NativeWorker=Worker;let stopped=0;
        class SilentWorker {
          constructor(){const worker=new NativeWorker(workerURL);const terminate=worker.terminate.bind(worker);worker.terminate=()=>{stopped++;terminate();};return worker;}
        }
        const client=clientModule.createGameTransferValidationClient({WorkerClass:SilentWorker});
        const start=performance.now();let code;
        try{await client.validate(text);}catch(e){code=e.code;}
        finally{client.dispose();URL.revokeObjectURL(workerURL);}
        return {code,elapsedMs:performance.now()-start,stopped};
      },fixtures[0].text);
      assert.equal(timeoutProbe.code,'VALIDATION_TIMEOUT');assert.equal(timeoutProbe.stopped,1);assert.ok(timeoutProbe.elapsedMs>=10000);
      results.push({timeoutProbe});console.log(JSON.stringify({timeoutProbe}));
    }
    await context.close();
  }
  assert.deepEqual(errors,[]);
}catch(e){errors.push(e.stack);console.error(e);process.exitCode=1;}
finally{
  await writeFile(path.join(out,'performance.json'),JSON.stringify({status:errors.length?'FAIL':'PASS',chrome:browser?.version(),source:'local exact working-tree modules; no product UI',limits:{bytes:1048576,plies:1024,timeoutMs:10000},cpuNote:'4x throttling applies to the page target; Worker CPU throttling is not asserted. This is not a real mobile-device benchmark.',results,errors,requests},null,2));
  await browser?.close();await new Promise(resolve=>server.close(resolve));
}
