// Independent backend implementation of the A1 framing contract. No frontend imports.
const forbidden = [
  '最佳著', '最佳', '最好', '比較好', '比較差', '失誤', '大錯', '大漏著',
  '白送', '掉子', '懸子', '優勢', '勝率', '評分', '評估值', '評估', '分數',
  '將軍', '将军', '將死', '将死', '困斃', '困毙', '長將', '长将',
  '重複', '重复', '判和', '判負', '判负', '獲勝', '获胜', '吃',
  '這步', '此步', '那步', '實戰', '候選', '走法', '著法', '棋步',
  '紅方', '黑方', '對方', '局面', '棋子',
];
const homographs = ['相信', '互相', '相同', '將來', '即將', '馬上', '士氣'];
const pieces = /[車车馬马炮砲俥傌相象仕士帥帅將将兵卒]/u;
const beforeChess = /[紅红黑棋前中後后車车馬马炮砲俥傌相象仕士帥帅將将兵卒]/u;
const afterChess = /[前後后左右進进退平移動动走吃攻守將将軍军棋步著着]/u;

function safeForm(text) {
  const chars = Array.from(text);
  if (chars.length < 1 || chars.length > 24 || text.trim() !== text
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>「」『』【】\[\]{}0-9]/u.test(text)
    || /(?:https?:\/\/|www\.|javascript\s*:|data\s*:)/i.test(text)
    || /\[[^\]]*\]\([^)]*\)/u.test(text)
    || /\b(?:score|evaluation|depth|pv|best|blunder|mistake)\b/i.test(text)
    || /[前中後]?[車车馬马炮砲俥傌相象仕士帥帅將将兵卒][一二三四五六七八九][平進进退][一二三四五六七八九]/u.test(text)
    || /[甲乙丙丁戊己庚辛壬癸一二三四五六七八九十Ａ-Ｚ][一二三四五六七八九十]/u.test(text)) return false;
  if (!chars.every((char) => /^(?:\p{Script=Han}|\p{Extended_Pictographic}|\p{Punctuation}|\p{Separator})$/u.test(char))) return false;
  const skeleton = chars.filter((char) => /[\p{Script=Han}A-Za-z0-9]/u.test(char)).join('');
  if (forbidden.some((term) => text.includes(term) || skeleton.includes(term))) return false;
  for (let i = 0; i < chars.length; i++) {
    if (!pieces.test(chars[i])) continue;
    const safe = homographs.some((word) => {
      const letters = Array.from(word);
      for (let start = i - letters.length + 1; start <= i; start++) {
        if (start < 0 || start + letters.length > chars.length) continue;
        if (letters.every((char, j) => chars[start + j] === char)
          && !beforeChess.test(chars[start - 1] || '')
          && !afterChess.test(chars[start + letters.length] || '')) return true;
      }
      return false;
    });
    if (!safe) return false;
  }
  return true;
}

export function safeFramingSegment(value) {
  return typeof value === 'string' && value.length <= 96
    && safeForm(value) && safeForm(value.normalize('NFKC'));
}
