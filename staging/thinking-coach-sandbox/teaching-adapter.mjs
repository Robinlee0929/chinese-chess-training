// Deterministic question selection. No text interpretation, chess search or grading.
const prompts = Object.freeze({
  observe: ['先找雙方將帥，再看看哪些棋子正受到威脅。', '先分清楚：現在已經被攻擊，還是下一步才可能發生？你能自己指出來嗎？'],
  candidate: ['你想用這一步保護什麼，或改變什麼？先記下理由。', '想像走完這一步：原來的保護還在嗎？對方最想做什麼？'],
  defense: ['換你當對手，你會先處理哪個威脅？自己標記一個預測。', '別只看自己想走的路線。試著檢查對手能否避開威脅、擋住攻擊或吃回棋子。'],
  variation: ['對手回應後，原來的理由還成立嗎？', '一次算一個半回合。每一步都重新確認將帥安全、吃子與可能的回吃。'],
  reflect: ['哪個回應是你一開始沒想到的？你想修改哪個想法？', '比較你真的試過的兩種候選：哪些理由保留下來，哪些要修改？沒有試過的部分先留白。'],
});
export function teaching(text) {
  if (typeof text !== 'string' || text.length > 1024) throw new Error('JSON_TEXT_REQUIRED');
  const c = JSON.parse(text);
  if (!c || Array.isArray(c) || Object.keys(c).some(k => !['stage','level','hasRecord','hasPrediction','mismatch'].includes(k))
    || !Object.hasOwn(prompts,c.stage) || ![1,2,3].includes(c.level)
    || ['hasRecord','hasPrediction','mismatch'].some(k => typeof c[k] !== 'boolean')) throw new Error('INVALID_TEACHING_CONTEXT');
  const question = c.level === 3
    ? (c.hasPrediction ? '只核對你自己標記的這一步；再看看結果是否符合你的預測。' : '先提出走法或標記預測，才能核對相應的棋規事實。')
    : c.mismatch && c.level === 2 ? '剛才的核對與你的預測不同。你漏看了哪一點？可以修改說法，再試一次。'
      : prompts[c.stage][c.level - 1];
  return JSON.stringify({ level:c.level, question, reminder:c.hasRecord ? '已保存你的說法；文字內容由你自己檢討，系統不評分。' : '可以先說給自己聽，再把想法記下。',
    boundary:'只核對已提出的走法和立即回應；不代表完整變化或優劣已獲證明。' });
}
