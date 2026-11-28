import { createGuidedSandbox as createSandbox } from './guidance-model.mjs';

const $ = id => document.getElementById(id);
const glyphs = { red: { K:'帥', A:'仕', B:'相', N:'馬', R:'車', C:'炮', P:'兵' }, black: { K:'將', A:'士', B:'象', N:'馬', R:'車', C:'砲', P:'卒' } };
const titles = { observe:'先觀察', candidate:'提出你的想法', defense:'換你扮演對手', variation:'再往下想一步', reflect:'回頭整理思路' };
let positions, model, view, selection = null, roving = 85, predicting = false, resetRequest = null, checking = null, predictionChecking = null;
const cells = [], say = text => { $('notice').textContent = text; };
const copyToken = () => ({ ...view.token });
function textElement(tag, text) { const element = document.createElement(tag); element.textContent = text; return element; }
const moveLabel = m => (m.from.r + 1) + '列' + (m.from.c + 1) + '行 → ' + (m.to.r + 1) + '列' + (m.to.c + 1) + '行';
function focusCell(index) {
  roving = index; cells.forEach((cell,i) => { cell.tabIndex = i === roving ? 0 : -1; });
  cells[roving].focus();
}
function message(error) {
  const messages = { ILLEGAL_MOVE:'這一步不符合棋規。棋盤沒有改變，再觀察看看。', OBSERVATION_REQUIRED:'先想一想，再按「我想好，來試走」。',
    DUPLICATE_CANDIDATE:'這個想法已經保留了，可以從候選中繼續。', TERMINAL_POSITION:'這條路線暫時不能繼續，可以悔棋或試另一種想法。',
    BRANCH_LIMIT:'已保留八種候選，先回頭比較看看。', NODE_LIMIT:'這條候選已保留很多步，先整理思路或重置練習。',
    STALE_VIEW:'畫面已更新，請在目前的局面再試一次。' };
  say(messages[error.code] || '這次操作沒有完成，請在目前的局面再試一次。');
}
function act(type, fields = {}, expectedToken = copyToken()) {
  try {
    if(expectedToken.key===view.token.key&&expectedToken.version===view.token.version&&type!=='reset'){
      if(!saveThought())return false;expectedToken=copyToken();
    }
    view = JSON.parse(model.act(JSON.stringify({ type, token: expectedToken, ...fields })));
    selection = null; predicting=false; render(); return true;
  } catch (error) { message(error); return false; }
}
function choose(r,c) {
  if (!model) return;
  roving = (9-r)*9+c;
  const piece = view.board[r][c];
  if (view.teaching.stage === 'observe') { say('先想一想，再按「我想好，來試走」。'); return; }
  if (selection?.r === r && selection?.c === c) { selection = null; renderBoard(); say('已取消選棋。'); return; }
  if (piece?.side === view.side) { selection = { r,c }; renderBoard(); say('已選好棋子，請自己決定要走到哪裡。'); return; }
  if (!selection) { say('請先選輪到的一方的棋子。'); return; }
  if(predicting){
    if(guide('forecast',{move:{from:selection,to:{r,c}},expect:Object.fromEntries(['check','capture','recapture'].map(k=>[k,$('expect-'+k).value]))})){
      selection=null;predicting=false;render();say('已記下你預測的回應，棋盤沒有走動。可按第三層提示核對。');
    }
  }else if (act('move', { move: { from: selection, to: { r,c } } })) say('這一步已保留。');
}
for (let r=9;r>=0;r--) for (let c=0;c<9;c++) {
  const button = document.createElement('button'); button.type='button'; button.className='cell'; button.dataset.r=r; button.dataset.c=c;
  button.addEventListener('click',()=>choose(r,c));
  button.addEventListener('keydown',event=>{
    const index=(9-r)*9+c, row=Math.floor(index/9), col=index%9;
    const next = { ArrowLeft:row*9+Math.max(0,col-1), ArrowRight:row*9+Math.min(8,col+1), ArrowUp:Math.max(0,row-1)*9+col, ArrowDown:Math.min(9,row+1)*9+col, Home:row*9, End:row*9+8 }[event.key];
    if (next!==undefined) { event.preventDefault(); focusCell(next); }
  });
  cells.push(button); $('board').append(button);
}
function line(x1,y1,x2,y2) { const e=document.createElementNS('http://www.w3.org/2000/svg','line'); for(const [k,v] of Object.entries({x1,y1,x2,y2}))e.setAttribute(k,v); $('lines').append(e); }
for(let i=0;i<10;i++)line(50,50+i*100,850,50+i*100);
for(let i=0;i<9;i++){ const x=50+i*100; if(i===0||i===8)line(x,50,x,950); else { line(x,50,x,450);line(x,550,x,950); } }
for(const y of [50,750]){line(350,y,550,y+200);line(550,y,350,y+200);}
function renderBoard() {
  for (const [i,button] of cells.entries()) {
    const r=9-Math.floor(i/9),c=i%9,p=view.board[r][c];
    button.replaceChildren(); button.tabIndex=i===roving?0:-1;
    button.setAttribute('aria-label',(p?(p.side==='red'?'紅':'黑')+'方'+glyphs[p.side][p.type]:'空位')+'，第'+(r+1)+'列第'+(c+1)+'行');
    button.setAttribute('aria-pressed',String(selection?.r===r&&selection?.c===c));
    if(p){const span=textElement('span',glyphs[p.side][p.type]);span.className='piece '+p.side;span.setAttribute('aria-hidden','true');button.append(span);}
  }
  $('turn').textContent='輪到'+(view.side==='red'?'紅':'黑')+'方';
}
function renderFacts() {
  const box=$('facts');box.replaceChildren();box.hidden=!view.facts;
  if (!view.facts) return;
  const f=view.facts;
  box.append(textElement('h3','已核對的局面事實'));
  box.append(textElement('p','對方有 '+f.replyCount+' 種立即合法回應，這個位置已探索 '+f.explored+' 種。'));
  box.append(textElement('p',f.checked?'輪到的一方目前被將軍。':'輪到的一方目前沒有被將軍。'));
  if(f.capture)box.append(textElement('p','你剛才這一步吃到了棋子；這本身不能證明走法好壞。'));
  if(f.recapture==='REFUTED')box.append(textElement('p','剛走的棋子，下一步可能被合法吃回。犧牲棋子不代表你的想法錯了。'));
  if(f.recapture==='SUPPORTED_FOR_NEXT_MOVE_ONLY')box.append(textElement('p','下一步沒有合法回吃剛走棋子的走法；更遠的變化仍未證明。'));
  if(f.terminal)box.append(textElement('p',f.terminal.reason==='checkmate'?'依目前棋面，輪到的一方已被將死。':f.terminal.reason==='stalemate'?'依目前棋面，輪到的一方已無合法走法。':'這個已宣告的歷史出現規則終局。'));
  for(const row of f.comparisons){const index=view.branches.findIndex(b=>b.id===row.id)+1;box.append(textElement('p','候選 '+index+'：第一步後有 '+row.replies+' 種立即合法回應，已探索 '+row.explored+' 種；尚未證明優劣。'));}
  box.append(textElement('p',f.history==='NOT_PROVEN'?'來源歷史不完整。以上只核對目前局面與立即回應，不能推論整局勝負或完整解答。':'只核對已宣告的歷史與立即回應，不能推論尚未走過的變化。'));
}
function render() {
  const active=document.activeElement, focused=active?.dataset.focus, renderToken=copyToken();
  renderBoard(); $('question').textContent=view.teaching.question; $('uncertainty').textContent=view.teaching.uncertainty; $('stage-title').textContent=titles[view.teaching.stage];
  document.querySelectorAll('[data-stage]').forEach(li=>{if(li.dataset.stage===view.teaching.stage)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});
  $('start').hidden=view.teaching.stage!=='observe'; $('thought').value=view.guidance.text;
  $('undo').disabled=!view.canUndo; $('root').disabled=view.rootMode; $('reflect').disabled=view.rootMode; $('check').disabled=!view.canCheck;
  $('another').disabled=view.teaching.stage==='observe'||view.branches.length>=8;
  $('empty').hidden=view.branches.length>0; $('branches').replaceChildren(); $('visited').replaceChildren();
  for(const [index,b] of view.branches.entries()){
    const button=document.createElement('button');button.className='branch';button.dataset.focus=b.id;button.dataset.branch=b.id;button.setAttribute('aria-pressed',String(b.id===view.selectedId));
    button.append(textElement('span','候選 '+(index+1)),textElement('small','已走 '+b.count+' 步'));
    button.addEventListener('click',()=>{if(act('branch',{id:b.id},renderToken))say('已回到候選 '+(index+1)+'。');});$('branches').append(button);
  }
  for(const [i,n] of view.visited.entries()){
    const button=textElement('button','路線節點 '+(i+1)+'：'+moveLabel(n.move));button.dataset.focus=n.id;button.dataset.node=n.id;
    if(n.selected)button.setAttribute('aria-current','true');
    button.addEventListener('click',()=>{if(act('node',{id:n.id},renderToken))say('已回到你走過的位置。');});$('visited').append(button);
  }
  if(!view.visited.length)$('visited').append(textElement('p','還沒有已走過的路線。'));
  renderFacts();
  renderGuidance();
  if(focused)document.querySelector('[data-focus="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
  if (active instanceof HTMLButtonElement && active.disabled && !$('reset-dialog').open) focusCell(roving);
}
function loadPosition() {
  const id=$('position').value, entry=positions.find(p=>p.id===id);
  model?.destroy();selection=null;predicting=false;roving=85;
  model=createSandbox(JSON.stringify({sessionId:'sandbox-'+crypto.randomUUID(),source:entry.source}));view=JSON.parse(model.view());render();say('先觀察局面，再開始試走。');
}
$('start').addEventListener('click',()=>{if(act('observe')){say('選一枚自己的棋子，試試你的想法。');focusCell(roving);}});
$('root').addEventListener('click',()=>{if(act('root'))say('回到原局面，已探索的候選仍保留。');});
$('another').addEventListener('click',()=>{if(act('root')){say('從原局面提出另一種候選。');focusCell(roving);}});
$('undo').addEventListener('click',()=>{if(act('undo'))say('已返回上一步，探索過的路線仍保留。');});
$('reflect').addEventListener('click',()=>{if(act('reflect'))say('比較自己的兩種想法；想確認事實時再按檢查。');});
$('save-thought').addEventListener('click',()=>{const saved=saveThought();if(saved){render();say(saved==='draft'?'已更新目前草稿；先前 16 次說法仍保留，可繼續切換或重置。':'已記下你的說法，沒有替文字評分。');}});
$('thought').addEventListener('input',()=>guide('draft',{text:$('thought').value}));
$('position').addEventListener('change',loadPosition);
$('reset').addEventListener('click',()=>{
  // Fence pending checks before capturing the confirmation token, without weakening identity checks.
  if (!act('clearFacts')) return;
  resetRequest={owner:model,token:copyToken()};$('reset-dialog').showModal();
});
$('reset-dialog').addEventListener('close',()=>{
  if($('reset-dialog').returnValue==='reset'&&resetRequest?.owner===model){if(act('reset',{},resetRequest.token)){$('thought').value='';say('已重新開始，這次練習的路線與筆記已清除。');}}
  resetRequest=null;$('reset-dialog').returnValue='';$('reset').focus({preventScroll:true});
});
$('check').addEventListener('click',async()=>{
  if(!saveThought())return;
  const owner=model,requestToken=copyToken();
  if(checking?.owner===owner&&checking.token.version===requestToken.version)return;
  const task={owner,token:requestToken};checking=task;$('check').setAttribute('aria-busy','true');
  try{const result=JSON.parse(await owner.check(JSON.stringify({type:'check',token:requestToken})));
    if(owner!==model||!result.accepted)return;view=result.view;render();say('已核對這個位置。這不是走法評分。');
  }catch(error){if(owner===model)message(error);}finally{if(checking===task){checking=null;$('check').removeAttribute('aria-busy');}if(owner===model)$('check').disabled=!view.canCheck;}
});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||$('reset-dialog').open||!model)return;
  if(selection||predicting){event.preventDefault();selection=null;predicting=false;renderBoard();renderGuidance();say('已取消選棋或預測標記。');focusCell(roving);}
  else if(view.guidance.disclosure){event.preventDefault();act('clearFacts');say('已收起預測核對。');$('hint-three').focus({preventScroll:true});}
  else if(view.facts){event.preventDefault();act('clearFacts');say('已收起檢查結果。');$('check').focus({preventScroll:true});}
});
function guide(type,fields={}){
  try{view=JSON.parse(model.guide(JSON.stringify({type,token:copyToken(),...fields})));render();return true;}
  catch(error){message(error);return false;}
}
function saveThought(){
  if(!view.guidance.canRecord)return true;
  if($('thought').value===view.guidance.savedText)return true;
  if(view.guidance.revisions.length>=16){
    if($('thought').value!==view.guidance.text&&!guide('draft',{text:$('thought').value}))return false;
    return 'draft';
  }
  try{view=JSON.parse(model.guide(JSON.stringify({type:'write',token:copyToken(),text:$('thought').value})));render();return true;}
  catch(error){message(error);return false;}
}
function renderGuidance(){
  const g=view.guidance,labels={observe:'我的觀察：什麼受到威脅？',candidate:'這個候選的理由：我希望改變什麼？',defense:'我的防守預測與理由',variation:'試走後，我的想法有什麼改變？',reflect:'我漏算了什麼？我要修改哪個判斷？'};
  $('thought-label').textContent=labels[view.teaching.stage];
  $('thought').disabled=!g.canRecord;$('save-thought').disabled=!g.canRecord;
  $('revision-status').textContent=!g.canRecord?'這次練習的紀錄空間已滿。舊紀錄仍保留，可返回、切換或重置。':g.revisions.length>=16?'先前 16 次說法已保留；之後更新目前草稿，仍可繼續切換或重置。':'';
  $('hint-question').textContent=g.prompt.question;$('text-boundary').textContent=g.prompt.reminder;
  $('challenge-progress').textContent='已保留 '+view.branches.length+' 種候選；目前路線 '+g.depth+' 個半回合。目標 '+g.target.candidates+' 種候選、'+g.target.plies+' 個半回合，可隨時整理思路。';
  $('target-candidates').value=g.target.candidates;$('target-depth').value=g.target.plies;
  for(const k of ['check','capture','recapture'])$('expect-'+k).value=g.expect[k];
  for(const k of ['check','capture','recapture'])$('expect-'+k).disabled=!g.canRecord;
  $('predict').disabled=view.rootMode||!g.canRecord;$('predict').setAttribute('aria-pressed',String(predicting));
  $('prediction-status').textContent=predicting?'正在標記預測：選棋、選落點，不會真的走棋。':g.prediction?'你標記的回應：'+moveLabel(g.prediction.move)+'。這仍是待核對的預測。':'尚未標記預測；先試一個候選，再換你當對手。';
  const facts=$('prediction-facts');facts.replaceChildren();facts.removeAttribute('data-kind');facts.hidden=!g.disclosure;
  if(g.disclosure){const f=g.disclosure.facts;facts.append(textElement('h3','你提出的預測：棋規核對'));
    facts.append(textElement('p',f.legal?'這一步符合目前局面的棋規。':'這一步不符合目前局面的棋規，棋盤未改變。'));
    if(f.legal){facts.append(textElement('p',(f.check?'形成將軍':'沒有形成將軍')+'；'+(f.capture?'吃到棋子':'沒有吃子')+'。'));facts.append(textElement('p',f.recapture?'存在立即合法回吃；犧牲棋子不代表想法錯誤。':'沒有立即合法回吃這枚棋子；更遠仍未證明。'));}
    facts.append(textElement('p',g.disclosure.mismatch?'核對與你的預測不同。你想修改哪一點？':'請自己比較預測與核對結果，理由仍由你檢討。'));
    facts.dataset.kind='CANONICAL_FACT';facts.append(textElement('p','已核對的棋規事實只涵蓋你提出的這一步與立即回吃；完整變化與優劣仍未證明。'));
  }
  const summary=$('reflection-records');summary.replaceChildren();summary.hidden=view.teaching.stage!=='reflect';
  if(!summary.hidden){summary.append(textElement('h3','我的思考紀錄'));
    for(const r of g.summary){const number=view.branches.findIndex(b=>b.id===r.context.branch)+1;const label=number?'候選 '+number:'原局面';summary.append(textElement('h4',label+' · '+titles[r.context.stage]));
      for(const text of r.texts)summary.append(textElement('p','我的說法（尚未證明）：'+text));
      for(const p of r.predictions){const words={yes:'會',no:'不會',unsure:'還不確定'};summary.append(textElement('p','我標記的回應：'+moveLabel(p.move)+'；將軍：'+words[p.expect.check]+'、吃子：'+words[p.expect.capture]+'、被回吃：'+words[p.expect.recapture]+'（尚未證明的預測）'));}}
    for(const b of g.explored){summary.append(textElement('p','候選 '+(view.branches.findIndex(x=>x.id===b.branch)+1)+' 已試走的節點：'+b.nodes.map(n=>moveLabel(n.move)).join('；')));}
    summary.append(textElement('p','以上只整理你輸入及試過的內容。即使試過所有立即回應，也沒有證明完整變化或優劣。'));
  }
}
for(const [id,level]of [['hint-one',1],['hint-two',2]])$(id).addEventListener('click',()=>{if(saveThought())guide('hint',{level});});
for(const k of ['check','capture','recapture'])$('expect-'+k).addEventListener('change',()=>{
  const expect=Object.fromEntries(['check','capture','recapture'].map(k=>[k,$('expect-'+k).value]));
  if(saveThought())guide('expect',{expect});
});
$('predict').addEventListener('click',()=>{if(!saveThought())return;predicting=!predicting;selection=null;renderBoard();renderGuidance();if(predicting)focusCell(roving);});
function changeTarget(){
  const target={candidates:+$('target-candidates').value,plies:+$('target-depth').value};
  if(saveThought())guide('target',target);
}
$('target-candidates').addEventListener('change',changeTarget);
$('target-depth').addEventListener('change',changeTarget);
$('hint-three').addEventListener('click',async()=>{
  if(!saveThought())return;if(!view.guidance.prediction){if(view.canCheck)$('check').click();else guide('hint',{level:3});return;}
  const owner=model,expected=copyToken(),task={owner};predictionChecking=task;$('hint-three').setAttribute('aria-busy','true');
  try{const result=JSON.parse(await owner.verifyPrediction(JSON.stringify({type:'verifyPrediction',token:expected})));if(owner!==model||!result.accepted)return;view=result.view;render();say('已核對你標記的預測，棋盤未移動。');}
  catch(error){if(owner===model)message(error);}finally{if(predictionChecking===task){predictionChecking=null;$('hint-three').removeAttribute('aria-busy');}}
});
addEventListener('pagehide',()=>model?.destroy());
addEventListener('pageshow',event=>{if(event.persisted&&positions)loadPosition();});
try {
  const response=await fetch('./positions.json',{cache:'no-store'});if(!response.ok)throw new Error('POSITIONS_UNAVAILABLE');
  positions=await response.json();loadPosition();$('app').inert=false;$('position').disabled=false;$('load-status').textContent='';
} catch { $('load-status').textContent='棋盤準備失敗，請重新整理。你的正式棋局不受影響。'; }
