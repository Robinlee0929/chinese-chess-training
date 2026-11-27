import { createSandbox } from './model.mjs';

const $ = id => document.getElementById(id);
const glyphs = { red: { K:'帥', A:'仕', B:'相', N:'馬', R:'車', C:'炮', P:'兵' }, black: { K:'將', A:'士', B:'象', N:'馬', R:'車', C:'砲', P:'卒' } };
const titles = { observe:'先觀察', candidate:'提出你的想法', defense:'換你扮演對手', variation:'再往下想一步', reflect:'回頭整理思路' };
let positions, model, view, selection = null, roving = 85, notes = new Map(), resetRequest = null, checking = null;
const cells = [], say = text => { $('notice').textContent = text; };
const copyToken = () => ({ ...view.token });
const noteKey = () => view.rootMode ? 'source' : view.selectedId;
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
    view = JSON.parse(model.act(JSON.stringify({ type, token: expectedToken, ...fields })));
    selection = null; render(); return true;
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
  if (act('move', { move: { from: selection, to: { r,c } } })) say('這一步已保留。');
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
  $('start').hidden=view.teaching.stage!=='observe'; $('thought').value=notes.get(noteKey())||'';
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
  if(focused)document.querySelector('[data-focus="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
  if (active instanceof HTMLButtonElement && active.disabled && !$('reset-dialog').open) focusCell(roving);
}
function loadPosition() {
  const id=$('position').value, entry=positions.find(p=>p.id===id);
  model?.destroy();selection=null;notes=new Map();roving=85;
  model=createSandbox(JSON.stringify({sessionId:'sandbox-'+crypto.randomUUID(),source:entry.source}));view=JSON.parse(model.view());render();say('先觀察局面，再開始試走。');
}
$('start').addEventListener('click',()=>{if(act('observe')){say('選一枚自己的棋子，試試你的想法。');focusCell(roving);}});
$('root').addEventListener('click',()=>{if(act('root'))say('回到原局面，已探索的候選仍保留。');});
$('another').addEventListener('click',()=>{if(act('root')){say('從原局面提出另一種候選。');focusCell(roving);}});
$('undo').addEventListener('click',()=>{if(act('undo'))say('已返回上一步，探索過的路線仍保留。');});
$('reflect').addEventListener('click',()=>{if(act('reflect'))say('比較自己的兩種想法；想確認事實時再按檢查。');});
$('thought').addEventListener('input',()=>notes.set(noteKey(),$('thought').value));
$('position').addEventListener('change',loadPosition);
$('reset').addEventListener('click',()=>{
  // Fence pending checks before capturing the confirmation token, without weakening identity checks.
  if (!act('clearFacts')) return;
  resetRequest={owner:model,token:copyToken()};$('reset-dialog').showModal();
});
$('reset-dialog').addEventListener('close',()=>{
  if($('reset-dialog').returnValue==='reset'&&resetRequest?.owner===model){if(act('reset',{},resetRequest.token)){notes.clear();$('thought').value='';say('已重新開始，這次練習的路線與筆記已清除。');}}
  resetRequest=null;$('reset-dialog').returnValue='';$('reset').focus({preventScroll:true});
});
$('check').addEventListener('click',async()=>{
  const owner=model,requestToken=copyToken();
  if(checking?.owner===owner&&checking.token.version===requestToken.version)return;
  const task={owner,token:requestToken};checking=task;$('check').setAttribute('aria-busy','true');
  try{const result=JSON.parse(await owner.check(JSON.stringify({type:'check',token:requestToken})));
    if(owner!==model||!result.accepted)return;view=result.view;render();say('已核對這個位置。這不是走法評分。');
  }catch(error){if(owner===model)message(error);}finally{if(checking===task){checking=null;$('check').removeAttribute('aria-busy');}if(owner===model)$('check').disabled=!view.canCheck;}
});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||$('reset-dialog').open||!model)return;
  if(selection){event.preventDefault();selection=null;renderBoard();say('已取消選棋。');focusCell(roving);}
  else if(view.facts){event.preventDefault();act('clearFacts');say('已收起檢查結果。');$('check').focus({preventScroll:true});}
});
addEventListener('pagehide',()=>model?.destroy());
addEventListener('pageshow',event=>{if(event.persisted&&positions)loadPosition();});
try {
  const response=await fetch('./positions.json',{cache:'no-store'});if(!response.ok)throw new Error('POSITIONS_UNAVAILABLE');
  positions=await response.json();loadPosition();$('app').inert=false;$('position').disabled=false;$('load-status').textContent='';
} catch { $('load-status').textContent='棋盤準備失敗，請重新整理。你的正式棋局不受影響。'; }
