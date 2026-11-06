// Local-only board appearance. No chess state, networking or storage access.
export const BOARD_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const BOARD_PHOTO_MAX_PIXELS = 24_000_000;
export const BOARD_PHOTO_MAX_SIDE = 8192;
export const BOARD_PHOTO_NORMALIZED_SIDE = 2048;
export const BOARD_PHOTO_STORED_BYTES = 2 * 1024 * 1024;
export const BOARD_PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const DEFAULT_BOARD_APPEARANCE = Object.freeze({ opacity: 0.5, x: 0.5, y: 0.5, fit: 'cover' });

export class BoardPhotoError extends Error {}
const invalidImage = () => { throw new BoardPhotoError('圖片內容無效，請選擇完整的 JPEG、PNG 或 WebP。'); };

export function validateBoardPhotoFile(file) {
  if (!file || !BOARD_PHOTO_TYPES.includes(file.type)) {
    throw new BoardPhotoError('請選擇 JPEG、PNG 或 WebP 圖片。');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) invalidImage();
  if (file.size > BOARD_PHOTO_MAX_BYTES) throw new BoardPhotoError('圖片不能超過 10 MiB。');
}

export function validateBoardPhotoDimensions(width, height, maxSide = BOARD_PHOTO_MAX_SIDE) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) invalidImage();
  if (width > maxSide || height > maxSide || width * height > BOARD_PHOTO_MAX_PIXELS) {
    throw new BoardPhotoError(`圖片最多 2,400 萬像素，單邊不能超過 ${maxSide} 像素。`);
  }
  return { width, height };
}

// Inspect bounded file bytes BEFORE asking the browser to allocate decoded pixels.
// The native decoder remains authoritative for the complete image (including CRCs).
export function inspectBoardPhoto(bytes, type) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at, text) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
  let width, height;
  if (type === 'image/png') {
    if (b.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => b[i] === n)
      || v.getUint32(8) !== 13 || !ascii(12, 'IHDR')) invalidImage();
    width = v.getUint32(16); height = v.getUint32(20);
    let ended = false;
    for (let p = 8; p + 12 <= b.length;) {
      const length = v.getUint32(p);
      if (p + 12 + length > b.length) invalidImage();
      if (ascii(p + 4, 'acTL')) throw new BoardPhotoError('請使用靜態圖片，暫不支援動態 PNG／WebP。');
      if (ascii(p + 4, 'IEND')) { ended = true; break; }
      p += length + 12;
    }
    if (!ended) invalidImage();
  } else if (type === 'image/jpeg') {
    if (b[0] !== 255 || b[1] !== 216) invalidImage();
    for (let p = 2; p < b.length;) {
      if (b[p++] !== 255) invalidImage();
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > b.length) invalidImage();
      const length = v.getUint16(p);
      if (length < 2 || p + length > b.length) invalidImage();
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
        if (length < 8) invalidImage();
        height = v.getUint16(p + 3); width = v.getUint16(p + 5);
        break;
      }
      p += length;
    }
  } else if (type === 'image/webp') {
    if (b.length < 20 || !ascii(0, 'RIFF') || !ascii(8, 'WEBP') || v.getUint32(4, true) + 8 !== b.length) invalidImage();
    for (let p = 12; p + 8 <= b.length;) {
      const length = v.getUint32(p + 4, true), start = p + 8;
      if (start + length > b.length) invalidImage();
      if (ascii(p, 'ANIM') || ascii(p, 'ANMF')) throw new BoardPhotoError('請使用靜態圖片，暫不支援動態 PNG／WebP。');
      if (ascii(p, 'VP8X')) {
        if (length < 10) invalidImage();
        if (b[start] & 2) throw new BoardPhotoError('請使用靜態圖片，暫不支援動態 PNG／WebP。');
        width = 1 + b[start + 4] + (b[start + 5] << 8) + (b[start + 6] << 16);
        height = 1 + b[start + 7] + (b[start + 8] << 8) + (b[start + 9] << 16);
      } else if (ascii(p, 'VP8 ') && width === undefined) {
        if (length < 10 || ![157, 1, 42].every((n, i) => b[start + 3 + i] === n)) invalidImage();
        width = v.getUint16(start + 6, true) & 16383; height = v.getUint16(start + 8, true) & 16383;
      } else if (ascii(p, 'VP8L') && width === undefined) {
        if (length < 5 || b[start] !== 47) invalidImage();
        const bits = v.getUint32(start + 1, true);
        width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
      }
      p = start + length + (length & 1);
    }
  } else invalidImage();
  return validateBoardPhotoDimensions(width, height);
}

export function validateBoardAppearanceSettings(value) {
  if (!value || !['cover', 'contain'].includes(value.fit)
    || ['opacity', 'x', 'y'].some(key => !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1)) {
    throw new BoardPhotoError('棋盤外觀設定無效。');
  }
  return { opacity: value.opacity, x: value.x, y: value.y, fit: value.fit };
}

export function boardPhotoPlacement(width, height, targetWidth, targetHeight, settings) {
  const { x, y, fit } = validateBoardAppearanceSettings(settings);
  const scale = Math[fit === 'cover' ? 'max' : 'min'](targetWidth / width, targetHeight / height);
  const w = width * scale, h = height * scale;
  return { x: (targetWidth - w) * x, y: (targetHeight - h) * y, width: w, height: h };
}

async function decodeBoardPhoto(blob) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { image: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
  }
  // Same native Image/Object URL approach as the existing puzzle photo importer.
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    image.decoding = 'async';
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    return { image, width: image.naturalWidth, height: image.naturalHeight,
      dispose: () => { image.removeAttribute('src'); } };
  } finally { URL.revokeObjectURL(url); }
}

export async function prepareBoardPhoto(file, { stored = false } = {}) {
  validateBoardPhotoFile(file);
  if (stored && file.size > BOARD_PHOTO_STORED_BYTES) invalidImage();
  const dimensions = inspectBoardPhoto(await file.arrayBuffer(), file.type);
  if (stored) validateBoardPhotoDimensions(dimensions.width, dimensions.height, BOARD_PHOTO_NORMALIZED_SIDE);
  let decoded, canvas;
  try {
    decoded = await decodeBoardPhoto(file);
    validateBoardPhotoDimensions(decoded.width, decoded.height);
    // EXIF orientation may swap the axes; any other mismatch fails closed.
    if (!((decoded.width === dimensions.width && decoded.height === dimensions.height)
      || (decoded.width === dimensions.height && decoded.height === dimensions.width))) invalidImage();
    const scale = Math.min(1, BOARD_PHOTO_NORMALIZED_SIDE / Math.max(decoded.width, decoded.height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Canvas unavailable');
    g.fillStyle = '#ead5b1'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
    decoded.dispose(); decoded = null;
    let blob;
    if (stored) blob = file;
    else for (const quality of [0.9, 0.8, 0.65]) {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= BOARD_PHOTO_STORED_BYTES) break;
    }
    if (!blob || blob.size > BOARD_PHOTO_STORED_BYTES) throw new BoardPhotoError('圖片縮小後仍太大，請選擇較簡單或較小的照片。');
    return { image: canvas, blob, dispose: () => { canvas.width = canvas.height = 1; } };
  } catch (error) {
    if (canvas) canvas.width = canvas.height = 1;
    if (error instanceof BoardPhotoError) throw error;
    throw new BoardPhotoError('圖片解碼失敗，請改用有效的 JPEG、PNG 或 WebP。');
  } finally { decoded?.dispose(); }
}

// All writes are ordered, including deletion. Late loads/saves cannot replace a
// newer session choice. Storage failure never removes the displayed photograph.
export function createBoardAppearanceController({ store, apply, prepare = prepareBoardPhoto, onChange = () => {} }) {
  let photo = null, settings = { ...DEFAULT_BOARD_APPEARANCE }, remember = false;
  let generation = 0, writeRevision = 0, disposed = false, loading = false;
  let persistence = 'session', message = '', queue = Promise.resolve(), decodeQueue = Promise.resolve();
  const prepareLatest = (file, options, token) => {
    const task = decodeQueue.catch(() => {}).then(() => disposed || token !== generation ? null : prepare(file, options));
    decodeQueue = task.then(() => {}, () => {});
    return task;
  };
  const state = () => ({ hasPhoto: !!photo, settings: { ...settings }, remember, loading, persistence, message });
  const emit = () => { if (!disposed) onChange(state()); };
  const show = () => apply(photo?.image ?? null, { ...settings });
  function persist() {
    if (disposed) return queue;
    const revision = ++writeRevision;
    const record = photo && remember ? { version: 1, blob: photo.blob, settings: { ...settings } } : null;
    persistence = 'saving'; message = ''; emit();
    queue = queue.catch(() => {}).then(async () => {
      if (disposed || revision !== writeRevision) return;
      try {
        if (record) await store.save(record); else await store.clear();
        if (disposed || revision !== writeRevision) return;
        persistence = record ? 'saved' : 'session';
        message = record ? '照片與外觀已記住，只保存在此瀏覽器。' : '已移除此裝置記住的照片。';
      } catch {
        if (disposed || revision !== writeRevision) return;
        persistence = 'error';
        message = record ? '無法確認保存成功；目前仍可使用照片。請重試保存。'
          : '無法確認已清除保存的照片；下次開啟可能仍會出現。請重試清除。';
      }
      emit();
    });
    return queue;
  }
  async function restore() {
    const token = generation;
    try {
      const record = await store.load();
      if (disposed || token !== generation || !record) return;
      const nextSettings = validateBoardAppearanceSettings(record.settings);
      const next = await prepareLatest(record.blob, { stored: true }, token);
      if (!next) return;
      if (disposed || token !== generation) { next.dispose(); return; }
      photo = next; settings = nextSettings; remember = true; persistence = 'saved'; show(); emit();
    } catch {
      if (disposed || token !== generation) return;
      message = '無法讀取已記住的照片，先使用木紋；你仍可上傳照片供本次使用。'; emit();
    }
  }
  return {
    state, restore,
    async select(file) {
      if (!file || disposed) return;
      const token = ++generation;
      loading = true; message = ''; emit();
      try {
        const next = await prepareLatest(file, {}, token);
        if (!next) return;
        if (disposed || token !== generation) { next.dispose(); return; }
        const previous = photo;
        photo = next; settings = { ...DEFAULT_BOARD_APPEARANCE };
        show(); previous?.dispose();
        message = '照片已套用。'; persistence = 'session';
        if (remember) void persist();
      } catch (error) {
        if (disposed || token !== generation) return;
        message = error instanceof BoardPhotoError ? error.message : '無法載入圖片，原本外觀保持不變。';
      } finally {
        if (!disposed && token === generation) { loading = false; emit(); }
      }
    },
    update(next, commit = true) {
      if (disposed || !photo) return;
      settings = validateBoardAppearanceSettings(next); show();
      if (remember) {
        // Preview edits also invalidate older save snapshots, even before a new
        // write is requested. The existing queue still orders saves and clears.
        writeRevision++;
        persistence = 'unsaved'; message = '外觀已調整，等待保存。';
      }
      emit();
      if (remember && commit) void persist();
    },
    setRemember(value) {
      if (disposed || !photo) return;
      remember = !!value; void persist();
    },
    reset() {
      if (disposed) return;
      generation++; loading = false; remember = false;
      const previous = photo; photo = null; settings = { ...DEFAULT_BOARD_APPEARANCE };
      show(); previous?.dispose(); return persist();
    },
    retry: persist,
    settled: () => queue,
    dispose() {
      if (disposed) return;
      disposed = true; generation++; writeRevision++;
      apply(null, { ...DEFAULT_BOARD_APPEARANCE }); photo?.dispose(); photo = null; store.dispose?.();
    },
  };
}

// The original board geometry/markings remain in canvas coordinates, 920 x 1020.
function drawBoardMarkings(g, contrast = false) {
  const COLS = 9, ROWS = 10, cell = 100, pad = 60, W = 920, H = 1020;
  const stroke = () => {
    if (contrast) { g.save(); g.strokeStyle = '#fff5e1'; g.lineWidth += 3; g.stroke(); g.restore(); }
    g.stroke();
  };
  const outlineRect = (...args) => {
    if (contrast) { g.save(); g.strokeStyle = '#fff5e1'; g.lineWidth += 3; g.strokeRect(...args); g.restore(); }
    g.strokeRect(...args);
  };
  const P = (r, c) => ({ x: pad + c * cell, y: pad + r * cell });
  const line = (a, b) => { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); stroke(); };

  // 外框
  g.strokeStyle = '#4a3320';
  g.lineWidth = 5;
  outlineRect(pad * 0.42, pad * 0.42, W - pad * 0.84, H - pad * 0.84);
  g.lineWidth = 3;
  outlineRect(pad, pad, W - pad * 2, H - pad * 2);

  // 橫線
  for (let r = 0; r < ROWS; r++) line(P(r, 0), P(r, COLS - 1));
  // 縱線（中間被楚河漢界斷開，兩邊界線貫穿）
  for (let c = 0; c < COLS; c++) {
    if (c === 0 || c === COLS - 1) line(P(0, c), P(ROWS - 1, c));
    else { line(P(0, c), P(4, c)); line(P(5, c), P(9, c)); }
  }
  // 九宮斜線
  line(P(0, 3), P(2, 5)); line(P(0, 5), P(2, 3));
  line(P(7, 3), P(9, 5)); line(P(7, 5), P(9, 3));

  // 星位（炮位、兵位）
  g.lineWidth = 2.5;
  const star = (r, c) => {
    const p = P(r, c), d = 12, o = 8;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x0 = p.x + sx * o, y0 = p.y + sy * o;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + sx * d, y0); stroke();
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0, y0 + sy * d); stroke();
    }
  };
  for (const [r, c] of [
    [2, 1], [2, 7], [7, 1], [7, 7],
    [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
    [6, 0], [6, 2], [6, 4], [6, 6], [6, 8],
  ]) star(r, c);

  // 楚河 / 漢界 —— 直書：字沿河界縱向排列，且在預設視角下正立
  // （貼圖相對於畫面旋轉了 90°：畫面上方 = 貼圖 +x，故字需旋轉 90° 並沿 x 排列）
  g.fillStyle = contrast ? '#4a3320' : 'rgba(74,51,32,0.8)';
  g.font = '56px "Kaiti SC","STKaiti","KaiTi","Noto Serif TC",serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const ry = (4 + 5) / 2 * cell + pad;
  const vChar = (ch, x) => {
    g.save();
    g.translate(x, ry);
    g.rotate(Math.PI / 2);
    if (contrast) { g.save(); g.strokeStyle = '#fff5e1'; g.lineWidth = 5; g.strokeText(ch, 0, 3); g.restore(); }
    g.fillText(ch, 0, 3);
    g.restore();
  };
  vChar('楚', 264); vChar('河', 196);          // 畫面下方直書「楚河」
  vChar('漢', W - 196); vChar('界', W - 264);  // 畫面上方直書「漢界」

}

export function createBoardSurface(canvas) {
  const W = 920, H = 1020;
  canvas.width = W; canvas.height = H;
  const defaultCanvas = document.createElement('canvas');
  defaultCanvas.width = W; defaultCanvas.height = H;
  const g = defaultCanvas.getContext('2d');
  // 木紋底
  const grd = g.createLinearGradient(0, 0, W, H);
  grd.addColorStop(0, '#e0b884');
  grd.addColorStop(0.5, '#d5a971');
  grd.addColorStop(1, '#c99c64');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 160; i++) {
    g.strokeStyle = `rgba(118,78,38,${0.03 + Math.random() * 0.05})`;
    g.lineWidth = 0.6 + Math.random() * 2.2;
    const y = Math.random() * H;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(W * 0.3, y + (Math.random() * 16 - 8), W * 0.65, y + (Math.random() * 16 - 8), W, y + (Math.random() * 10 - 5));
    g.stroke();
  }

  drawBoardMarkings(g);
  let image = null, settings = { ...DEFAULT_BOARD_APPEARANCE };
  const context = canvas.getContext('2d');
  function paint(photo = image, appearance = settings) {
    context.clearRect(0, 0, W, H);
    if (!photo) { context.drawImage(defaultCanvas, 0, 0); return; }
    context.save();
    context.fillStyle = '#ead5b1'; context.fillRect(0, 0, W, H);
    const box = boardPhotoPlacement(photo.width, photo.height, W, H, appearance);
    context.globalAlpha = appearance.opacity;
    context.drawImage(photo, box.x, box.y, box.width, box.height);
    context.globalAlpha = 1;
    drawBoardMarkings(context, true);
    context.restore();
  }
  paint();
  return {
    canvas,
    setPhoto(photo, next) { image = photo; settings = validateBoardAppearanceSettings(next); paint(); },
    // Synchronous capture: no animation frame can observe the temporary wood.
    // Restore and render even if capture throws. Never change game/camera state.
    withDefault(capture, render) {
      paint(null);
      try { render(); return capture(); }
      finally { paint(); render(); }
    },
  };
}
