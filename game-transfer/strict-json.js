import { GAME_TRANSFER_MAX_BYTES, GAME_TRANSFER_MAX_DEPTH, fail } from './contract.js?v=151972aca4';

// Count raw bytes before removing one optional UTF-8 BOM. A second BOM is invalid.
export function decodeTransferInput(input) {
  let text, byteLength;
  if (typeof input === 'string') {
    if (input.length > GAME_TRANSFER_MAX_BYTES) fail('FILE_TOO_LARGE', '棋譜檔案不可超過 1 MiB。');
    byteLength = new TextEncoder().encode(input).byteLength;
    text = input;
  } else if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    byteLength = bytes.byteLength;
    if (byteLength > GAME_TRANSFER_MAX_BYTES) fail('FILE_TOO_LARGE', '棋譜檔案不可超過 1 MiB。', { byteLength });
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('INVALID_UTF8', '棋譜檔案必須是有效的 UTF-8 文字。'); }
  } else {
    fail('INVALID_INPUT', '請提供 JSON 文字或 UTF-8 位元組。');
  }
  if (byteLength > GAME_TRANSFER_MAX_BYTES) fail('FILE_TOO_LARGE', '棋譜檔案不可超過 1 MiB。', { byteLength });
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Recursive descent over JSON tokens, with a per-object set of decoded keys.
// String contents are never searched for apparent keys or structural punctuation.
export function parseStrictTransferJSON(input) {
  const text = decodeTransferInput(input);
  let at = 0;
  const syntax = () => fail('INVALID_JSON', '棋譜不是有效的 JSON。', { offset: at });
  const white = () => { while (' \t\r\n'.includes(text[at]) && at < text.length) at++; };
  const digit = c => c >= '0' && c <= '9';
  function string() {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') {
        try { return JSON.parse(text.slice(start, at)); } catch { syntax(); }
      }
      if (c.charCodeAt(0) < 32) syntax();
      if (c === '\\') {
        const escape = text[at++];
        if (escape === 'u') {
          for (let n = 0; n < 4; n++) {
            const hex = text[at++];
            if (!hex || !'0123456789abcdefABCDEF'.includes(hex)) syntax();
          }
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) syntax();
      }
    }
    syntax();
  }
  function number() {
    const start = at;
    if (text[at] === '-') at++;
    if (text[at] === '0') at++;
    else {
      if (!(text[at] >= '1' && text[at] <= '9')) syntax();
      while (digit(text[at])) at++;
    }
    if (text[at] === '.') {
      at++;
      if (!digit(text[at])) syntax();
      while (digit(text[at])) at++;
    }
    if (text[at] === 'e' || text[at] === 'E') {
      at++;
      if (text[at] === '+' || text[at] === '-') at++;
      if (!digit(text[at])) syntax();
      while (digit(text[at])) at++;
    }
    const value = Number(text.slice(start, at));
    if (!Number.isFinite(value)) syntax();
    return value;
  }
  function value(depth) {
    white();
    const c = text[at];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      if (depth + 1 > GAME_TRANSFER_MAX_DEPTH) fail('MAX_DEPTH_EXCEEDED', 'JSON 巢狀深度不可超過 16。', { offset: at });
      at++;
      const object = c === '{', close = object ? '}' : ']';
      const result = object ? {} : [], keys = new Set();
      white();
      if (text[at] === close) { at++; return result; }
      while (at < text.length) {
        white();
        if (object) {
          if (text[at] !== '"') syntax();
          const key = string();
          if (keys.has(key)) fail('DUPLICATE_FIELD', 'JSON 物件含有重複欄位。', { offset: at });
          keys.add(key);
          white();
          if (text[at++] !== ':') syntax();
          // Define data properties: even __proto__ never invokes an inherited setter.
          Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        } else result.push(value(depth + 1));
        white();
        if (text[at] === close) { at++; return result; }
        if (text[at++] !== ',') syntax();
      }
      syntax();
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    if (c === '-' || digit(c)) return number();
    syntax();
  }
  const result = value(0);
  white();
  if (at !== text.length) syntax();
  return result;
}
