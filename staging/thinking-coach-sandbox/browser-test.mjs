// Full Chrome, isolated contexts, synthetic source data. Evidence stays outside checkout.
// PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node browser-test.mjs EXTERNAL_OUTPUT
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createCoachSession } from '../thinking-coach-core/core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=path.resolve(process.argv[2]);
assert(!out.startsWith(path.resolve(root)+path.sep));fs.mkdirSync(out,{recursive:false});
const fixtures=JSON.parse(fs.readFileSync(new URL('../thinking-coach-core/fixtures.json',import.meta.url))).fixtures;
const source=new Map(['model.mjs','app.mjs'].map(n=>[n,fs.readFileSync(new URL(n,import.meta.url),'utf8')]));
const mutations=[
  {name:'hidden-answer',file:'app.mjs',from:'if (!view.facts) return;',to:"if (!view.facts) { const leak=document.createElement('p');leak.hidden=true;leak.textContent='最佳著：測試解答';box.append(leak);return; }",oracle:'no-default-leak'},
  {name:'accessible-answer',file:'app.mjs',from:"$('question').textContent=view.teaching.question;",to:"$('question').textContent=view.teaching.question;$('question').setAttribute('aria-label','最佳著：測試解答');",oracle:'no-default-leak'},
  {name:'stale-view',file:'model.mjs',from:'command.token?.version !== version',to:'false',oracle:'stale-view'},
  {name:'cross-session',file:'model.mjs',from:'command.token?.key !== key',to:'false',oracle:'cross-session'},
  {name:'stale-facts',file:'model.mjs',from:'facts = null; version++;',to:'version++;',oracle:'clear-facts'},
  {name:'board-corruption',file:'model.mjs',from:'board: position.board,',to:'board: position.board.map((row,r)=>row.map((p,c)=>r===0&&c===4?null:p)),',oracle:'initial-board'},
  {name:'prune-exploration',file:'model.mjs',from:"else run('undo');",to:"else run('resetBranch', { id: branch.id });",oracle:'preserve-routes'},
  {name:'accept-illegal-intent',file:'model.mjs',from:'{ move: c.move }); rootMode = false;',to:'{ move: c.move.from.r===4&&c.move.from.c===4 ? {from:{r:2,c:0},to:{r:2,c:4}} : c.move }); rootMode = false;',oracle:'illegal-atomic'},
  {name:'storage-write',file:'app.mjs',from:"if(act('observe')){say",to:"if(act('observe')){localStorage.setItem('sandbox-leak','1');say",oracle:'no-storage'},
  {name:'missing-focus-fallback',file:'app.mjs',from:"if (active instanceof HTMLButtonElement && active.disabled && !$('reset-dialog').open) focusCell(roving);",to:'/* focus fallback removed */',oracle:'focus-fallback'},
  {name:'reset-check-race',file:'app.mjs',from:"if (!act('clearFacts')) return;",to:'/* pending check not fenced */',oracle:'reset-race'},
];
for(const m of mutations)assert.equal(source.get(m.file).split(m.from).length-1,1,m.name+' exact mutation site');
const server=createServer((req,res)=>{
  try{
    let pathname=new URL(req.url,'http://localhost').pathname,mutation=null;
    if(pathname.startsWith('/mutant/')){const parts=pathname.split('/');mutation=mutations.find(m=>m.name===parts[2]);assert(mutation);pathname='/'+parts.slice(3).join('/');}
    if(pathname.endsWith('/'))pathname+='index.html';
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));assert(file.startsWith(path.resolve(root)+path.sep));
    const extension=path.extname(file);assert(['.html','.js','.mjs','.css','.json'].includes(extension));
    let bytes=fs.readFileSync(file);
    if(mutation&&pathname==='/staging/thinking-coach-sandbox/'+mutation.file)bytes=Buffer.from(source.get(mutation.file).replace(mutation.from,mutation.to));
    res.writeHead(200,{'Content-Type':{'.html':'text/html','.css':'text/css','.json':'application/json','.mjs':'text/javascript','.js':'text/javascript'}[extension]+'; charset=utf-8','Cache-Control':'no-store'});res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const report={status:'RUNNING',browser:browser.version(),start:new Date().toISOString(),base,positive:[],negative:[],errors:[],contexts:0,requests:[],sourceHashes:Object.fromEntries([...source].map(([n,s])=>[n,createHash('sha256').update(s).digest('hex')]))};
const widths=[[320,568],[375,812],[390,844],[844,390],[1440,1000]];
const f=id=>fixtures.find(x=>x.id===id), cell=(page,p)=>page.locator('.cell[data-r="'+p.r+'"][data-c="'+p.c+'"]');
async function board(page){return page.locator('.cell').evaluateAll(cells=>{const b=Array.from({length:10},()=>Array(9).fill(null));for(const c of cells){const p=c.querySelector('.piece');if(p)b[+c.dataset.r][+c.dataset.c]={text:p.textContent,side:p.classList.contains('red')?'red':'black'};}return b;});}
const symbols={red:{K:'帥',A:'仕',B:'相',N:'馬',R:'車',C:'炮',P:'兵'},black:{K:'將',A:'士',B:'象',N:'馬',R:'車',C:'砲',P:'卒'}};
const visibleBoard=b=>b.map(row=>row.map(p=>p?{text:symbols[p.side][p.type],side:p.side}:null));
async function click(page,locator,touch){if(touch)await locator.tap();else await locator.click();}
async function move(page,m,touch=false){await click(page,cell(page,m.from),touch);await click(page,cell(page,m.to),touch);}
// Native dialog closes visually before its queued close event runs. The app clears
// returnValue only after that handler applies the guarded reset; wait for both.
async function resetSettled(page){await page.waitForFunction(()=>{const d=document.getElementById('reset-dialog');return !d.open&&d.returnValue==='';});}
async function noLeak(page){
  assert.equal(await page.locator('#facts').innerHTML(),'','hidden fact DOM must be empty');
  const dom=await page.locator('body').evaluate(e=>e.outerHTML),ax=await page.locator('body').ariaSnapshot();
  assert(!/最佳著|測試解答|legalMoves|legalReplies|unexplored|sourceFingerprint|replyCount|已被將死|種立即合法回應/.test(dom+'\n'+ax),'default DOM / accessibility answer leak');
}
async function open(size=[1440,1000],mutant=''){
  report.contexts++;const ctx=await browser.newContext({viewport:{width:size[0],height:size[1]},hasTouch:size[0]<=390||size[1]<=390});
  await ctx.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await ctx.addInitScript(()=>{
    localStorage.setItem('synthetic-preserved','sentinel');globalThis.__writes=[];
    for(const k of ['setItem','removeItem','clear'])Storage.prototype[k]=function(){__writes.push('storage.'+k);throw Error('STORAGE_WRITE_DETECTED');};
    for(const k of ['open','deleteDatabase'])IDBFactory.prototype[k]=function(){__writes.push('idb.'+k);throw Error('STORAGE_WRITE_DETECTED');};
    globalThis.Worker=class{constructor(){__writes.push('Worker');throw Error('WORKER_FORBIDDEN');}};
  });
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>report.requests.push(r.url()));
  const prefix=(mutant?'/mutant/'+mutant:'')+'/staging/thinking-coach-sandbox/';await page.goto(base+prefix);
  await page.waitForFunction(()=>!document.getElementById('app').inert&&document.querySelectorAll('.cell').length===90);
  assert.equal(await page.title(),'思考練習室｜象棋思考沙盒');assert.equal(await page.locator('#load-status').innerText(),'');
  return{ctx,page,errors,prefix};
}
async function clean(page,errors){assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>__writes),[]);assert.equal(await page.evaluate(()=>localStorage.getItem('synthetic-preserved')),'sentinel');}
async function record(name,fn){const detail=await fn();report.positive.push({name,status:'PASS',detail});fs.writeFileSync(out+'/results.json',JSON.stringify(report,null,2));console.log('PASS '+name);}
try{
  for(const size of widths)for(const id of ['A','B','C','D'])await record(size.join('x')+' fixture '+id,async()=>{
    const {ctx,page,errors}=await open(size),touch=size[0]<=390||size[1]<=390;
    await page.locator('#position').selectOption(id);assert.deepEqual(await board(page),visibleBoard(f(id).source.board));await noLeak(page);
    assert.equal(await page.locator('.cell[tabindex="0"]').count(),1);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
    if(id==='A')await page.screenshot({path:out+'/initial-'+size.join('x')+'.png',fullPage:true});
    await click(page,page.locator('#start'),touch);
    if(id==='C'){const before=await board(page);await move(page,{from:{r:4,c:4},to:{r:6,c:5}},touch);assert.deepEqual(await board(page),before);assert.equal(await page.locator('[data-branch]').count(),0);assert.match(await page.locator('#notice').innerText(),/不符合棋規/);}
    await move(page,f(id).candidate,touch);
    const core=createCoachSession({sessionId:'browser-expected',source:f(id).source});core.observe();const expected=core.addCandidate(f(id).candidate).branches[0].nodes[0].position;
    assert.deepEqual(await board(page),visibleBoard(expected.board));assert.equal(await page.locator('[data-branch]').count(),1);await noLeak(page);
    await click(page,page.locator('#check'),touch);await page.locator('#facts h3').waitFor();assert.match(await page.locator('#facts').innerText(),new RegExp('有 '+f(id).expected.replyCount+' 種'));
    if(id==='D')assert.match(await page.locator('#facts').innerText(),/已被將死/);
    if(id==='B')assert.match(await page.locator('#facts').innerText(),/犧牲棋子不代表/);
    await page.keyboard.press('Escape');await noLeak(page);assert.equal(await page.evaluate(()=>document.activeElement.id),'check');
    await click(page,page.locator('#undo'),touch);assert.deepEqual(await board(page),visibleBoard(f(id).source.board));assert.equal(await page.locator('[data-branch]').count(),1);
    await click(page,page.locator('[data-branch]').first(),touch);assert.deepEqual(await board(page),visibleBoard(expected.board));
    await click(page,page.locator('#reset'),touch);await page.keyboard.press('Escape');await page.locator('#reset-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('[data-branch]').count(),1);assert.equal(await page.evaluate(()=>document.activeElement.id),'reset');
    await click(page,page.locator('#reset'),touch);await page.locator('#confirm-reset').click();await resetSettled(page);
    assert.deepEqual(await board(page),visibleBoard(f(id).source.board));assert.equal(await page.locator('[data-branch]').count(),0);assert.equal(await page.locator('.cell[tabindex="0"]').count(),1);await noLeak(page);await clean(page,errors);await ctx.close();
    return{input:touch?'simulated touch':'mouse',fixture:id,resetAndCancel:true,domAndAccessibilityLeakAudit:true};
  });
  for(const size of widths)await record(size.join('x')+' keyboard, focus and alternatives',async()=>{
    const {ctx,page,errors}=await open(size);await page.locator('#position').selectOption('B');await page.locator('#thought').fill('<img src=x onerror=alert(1)> 我的想法');
    await page.locator('#start').click();assert.equal(await page.locator('.cell:focus').count(),1);
    for(let i=0;i<4;i++)await page.keyboard.press('ArrowUp');for(let i=0;i<4;i++)await page.keyboard.press('ArrowLeft');await page.keyboard.press('Enter');
    assert.equal(await cell(page,{r:4,c:0}).getAttribute('aria-pressed'),'true');await page.keyboard.press('Escape');assert.equal(await page.locator('.cell[aria-pressed=true]').count(),0);
    await page.keyboard.press('Space');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');assert.equal(await page.locator('[data-branch]').count(),1);
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'undo');
    await page.locator('#another').click();await move(page,f('B').expected.alternative);assert.equal(await page.locator('[data-branch]').count(),2);await noLeak(page);
    await page.locator('#reflect').click();assert.match(await page.locator('#question').innerText(),/沒想到/);await page.locator('#check').click();await page.locator('#facts h3').waitFor();assert.match(await page.locator('#facts').innerText(),/候選 2/);assert.match(await page.locator('#facts').innerText(),/尚未證明優劣/);
    await page.locator('[data-branch]').first().click();await noLeak(page);assert.equal(await page.locator('[data-branch]:focus').count(),1);
    await page.screenshot({path:out+'/explored-'+size.join('x')+'.png',fullPage:true});
    await page.locator('#position').selectOption('A');assert.equal(await page.locator('[data-branch]').count(),0);assert.equal(await page.locator('#thought').inputValue(),'');await noLeak(page);
    assert.equal(await page.locator('img').count(),0);await clean(page,errors);await ctx.close();return{keyboard:true,alternatives:2,focus:true,notesIsolation:true};
  });
  await record('A all three defenses and retained node navigation',async()=>{
    const {ctx,page,errors}=await open();await page.locator('#start').click();await move(page,f('A').candidate);
    for(const defense of f('A').expected.replies){await move(page,defense);await page.locator('#undo').click();}
    await page.locator('#routes summary').click();assert.equal(await page.locator('[data-node]').count(),4);await page.locator('[data-node]').last().click();assert.equal(await page.locator('[data-node][aria-current]').innerText(),await page.locator('[data-node]').last().innerText());
    await page.locator('[data-node]').first().click();await page.locator('#check').click();await page.locator('#facts h3').waitFor();assert.match(await page.locator('#facts').innerText(),/已探索 3 種/);
    await clean(page,errors);await ctx.close();return{defenses:3,nodesRetained:4};
  });
  await record('queued check cannot repaint a switched fixture or reset session',async()=>{
    const {ctx,page,errors}=await open();await page.locator('#start').click();await move(page,f('A').candidate);
    await page.evaluate(()=>{document.getElementById('check').click();const p=document.getElementById('position');p.value='D';p.dispatchEvent(new Event('change'));});
    await page.waitForTimeout(30);await noLeak(page);assert.deepEqual(await board(page),visibleBoard(f('D').source.board));
    await page.locator('#start').click();await move(page,f('D').candidate);
    await page.evaluate(()=>{document.getElementById('check').click();document.getElementById('reset').click();document.getElementById('reset-dialog').close('reset');});
    await resetSettled(page);await page.waitForTimeout(30);await noLeak(page);assert.equal(await page.locator('[data-branch]').count(),0);
    await clean(page,errors);await ctx.close();return{switch:true,reset:true};
  });
  for(const size of widths)await record(size.join('x')+' focus fallback and native reset/check race',async()=>{
    const {ctx,page,errors}=await open(size);await page.locator('#start').click();await move(page,f('A').candidate);
    await page.locator('#undo').click();assert.equal(await page.locator('.cell:focus').count(),1);
    await page.locator('[data-branch]').first().click();await page.locator('#root').click();assert.equal(await page.locator('.cell:focus').count(),1);
    await page.locator('[data-branch]').first().click();await page.locator('#check').click();await page.locator('#facts h3').waitFor();assert.equal(await page.evaluate(()=>document.activeElement.id),'check');
    await page.evaluate(()=>{document.getElementById('check').click();document.getElementById('reset').click();});
    await page.waitForFunction(()=>!document.getElementById('check').hasAttribute('aria-busy'));
    assert(await page.locator('#reset-dialog').evaluate(d=>d.open));assert(await page.locator('#reset-dialog').evaluate(d=>d.contains(document.activeElement)));
    await page.locator('#confirm-reset').click();await resetSettled(page);assert.equal(await page.locator('[data-branch]').count(),0);assert.equal(await page.evaluate(()=>document.activeElement.id),'reset');await noLeak(page);
    await clean(page,errors);await ctx.close();return{undoFocus:true,rootFocus:true,checkFocus:true,nativeRaceResetSucceeded:true};
  });
  for(const mutation of mutations){
    const {ctx,page,prefix}=await open([1440,1000],mutation.name);let detected=false,reason;
    // Initialization and imports are outside the detection catch; failures cannot count.
    await page.evaluate(async prefix=>{globalThis.__sandboxModule=await import(prefix+'model.mjs');},prefix);
    try{
      if(mutation.oracle==='no-default-leak')await noLeak(page);
      else if(mutation.oracle==='initial-board')assert.deepEqual(await board(page),visibleBoard(f('A').source.board));
      else if(mutation.oracle==='no-storage'){await page.locator('#start').click();assert.deepEqual(await page.evaluate(()=>__writes),[]);}
      else if(mutation.oracle==='illegal-atomic'){await page.locator('#position').selectOption('C');await page.locator('#start').click();const before=await board(page);await move(page,{from:{r:4,c:4},to:{r:6,c:5}});assert.deepEqual(await board(page),before);}
      else if(mutation.oracle==='preserve-routes'){await page.locator('#start').click();await move(page,f('A').candidate);await move(page,f('A').expected.replies[0]);await page.locator('#undo').click();assert.equal(await page.locator('[data-node]').count(),2);}
      else if(mutation.oracle==='clear-facts'){await page.locator('#start').click();await move(page,f('A').candidate);await page.locator('#check').click();await page.locator('#facts h3').waitFor();await page.locator('#undo').click();await noLeak(page);}
      else if(mutation.oracle==='focus-fallback'){await page.locator('#start').click();await move(page,f('A').candidate);await page.locator('#undo').click();assert.equal(await page.locator('.cell:focus').count(),1);}
      else if(mutation.oracle==='reset-race'){await page.locator('#start').click();await move(page,f('A').candidate);await page.evaluate(()=>{document.getElementById('check').click();document.getElementById('reset').click();});await page.waitForFunction(()=>!document.getElementById('check').hasAttribute('aria-busy'));await page.locator('#confirm-reset').click();await resetSettled(page);assert.equal(await page.locator('[data-branch]').count(),0);}
      else {
        const rejected=await page.evaluate(({source,oracle})=>{
          const m=__sandboxModule.createSandbox(JSON.stringify({sessionId:'same-id',source})),other=__sandboxModule.createSandbox(JSON.stringify({sessionId:'same-id',source}));
          const old=JSON.parse(m.view()).token,foreign=JSON.parse(other.view()).token;
          if(oracle==='stale-view')m.act(JSON.stringify({type:'observe',token:old}));
          let rejected=false;try{m.act(JSON.stringify({type:'reset',token:oracle==='stale-view'?old:foreign}));}catch(e){rejected=e.code==='STALE_VIEW';}
          m.destroy();other.destroy();return rejected;
        },{source:f('A').source,oracle:mutation.oracle});assert.equal(rejected,true);
      }
    }catch(e){if(e.code==='ERR_ASSERTION'){detected=true;reason=e.message;}else throw e;}
    report.negative.push({name:mutation.name,oracle:mutation.oracle,initializationSucceeded:true,importSucceeded:true,detected,reason});await ctx.close();assert(detected,mutation.name+' ineffective');console.log('DETECTED '+mutation.name);
  }
  assert(report.requests.every(url=>new URL(url).origin===base));assert(!report.requests.some(url=>/fixtures\.json|test-data\.mjs|node:/.test(url)));
  report.status='PASS';
}catch(error){report.status='FAIL';report.errors.push(error.stack);process.exitCode=1;}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));report.end=new Date().toISOString();fs.writeFileSync(out+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,positive:report.positive.length,negative:report.negative.filter(n=>n.detected).length,errors:report.errors}));}
