import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
const guide = html.match(/<dialog id="quickStartDialog"[\s\S]*?<\/dialog>/)[0];
const ui = html.replace(guide, '');
const text = value => value.replace(/<[^>]+>/g, '').trim();

test('every quoted quick-start control names a real UI control or current library action', () => {
  const names = new Set([...ui.matchAll(/<(button|option|label|legend)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(m => text(m[2])));
  for (const m of ui.matchAll(/aria-label="([^"]+)"/g)) names.add(m[1]);
  for (const m of main.matchAll(/\['(?:view|practice|delete)', '([^']+)'/g)) names.add(m[1]);
  names.add('新對局'); names.add('新局'); // Responsive spans of the same button.
  names.add('固定視角：關'); // Dynamic label, checked against its implementation below.
  assert.match(main, /viewLocked \? '固定視角：開' : '固定視角：關'/);
  for (const m of guide.matchAll(/「([^」]+)」/g)) {
    const label = m[1].replace(/^⋯ /, '');
    assert.ok(names.has(label), `Guide names a missing control: ${m[1]}`);
  }
});

test('teacher route names recording completion, storage and the actual library detail action', () => {
  const teacher = guide.match(/<section id="teacherQuickStart"[\s\S]*?<\/section>/)[0];
  const route = ['建立殺局', '確認局面', '開始錄製答案', '完成答案', '題目名稱', '儲存題目', '我的殺局', '匯出此題'];
  let index = 0;
  for (const step of route) { const found = teacher.indexOf(`「${step}」`, index); assert.ok(found >= index, step); index = found + step.length + 2; }
  assert.match(teacher, /最後必須將死/);
  assert.match(teacher, /若看到題目列表，先按題目的「檢視」/);
  assert.match(teacher, /單|一條解答路線/);
  assert.match(main, /\['view', '檢視', ''\]/);
});

test('guide and README distinguish puzzle import, full-game import, TXT, positions and photos', () => {
  for (const content of [guide, readme]) {
    for (const term of ['殺局 JSON', '完整對局 JSON', '匯入 JSON', '匯入棋譜 JSON', 'TXT', '我的局面', '棋盤背景照片']) assert.ok(content.includes(term), term);
    assert.match(content, /不能當成完整對局 JSON 匯入/);
    assert.match(content, /不是完整對局棋譜/);
    assert.match(content, /不包含在棋譜 JSON/);
  }
});

test('guide and README state temporary storage, manual export, cloud and account limits', () => {
  for (const content of [guide, readme]) {
    for (const term of ['重新整理', '當前分頁暫存', '不永久儲存', '手動匯出', '本機儲存不是雲端同步', '清除網站資料', '沒有線上派發作業、帳號或班級管理', '不保證最佳著']) assert.ok(content.includes(term), term);
  }
});

test('README reflects U0 protection and keeps upstream attribution and MIT license', () => {
  assert.doesNotMatch(readme + guide, /切換即開新局|挑戰級（試玩）（本機原型）/);
  for (const label of ['要開始新對局嗎？', '取消，繼續這盤', '放棄進度，開始新局']) assert.ok(ui.includes(label) && readme.includes(label), label);
  assert.match(readme, /自訂起點即使零著也受保護/);
  assert.match(readme, /標準起點沒有進度時可直接開新局/);
  assert.match(readme, /https:\/\/github.com\/doggy8088\/chinese-chess/);
  assert.match(readme, /\[MIT License\]\(LICENSE\) © Will 保哥/);
});
