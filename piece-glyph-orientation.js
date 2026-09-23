export const PIECE_GLYPH_ORIENTATION_KEY = 'xiangqi.pieceGlyphOrientationMode.v1';
export const ALL_UPRIGHT = 'all-upright';
export const FACE_OPPONENT = 'face-opponent';

export function normalizePieceGlyphOrientationMode(value) {
  return value === FACE_OPPONENT ? FACE_OPPONENT : ALL_UPRIGHT;
}

export function readPieceGlyphOrientationMode(getStorage) {
  try {
    return normalizePieceGlyphOrientationMode(getStorage()?.getItem(PIECE_GLYPH_ORIENTATION_KEY));
  } catch {
    return ALL_UPRIGHT;
  }
}

export function writePieceGlyphOrientationMode(getStorage, value) {
  if (value !== ALL_UPRIGHT && value !== FACE_OPPONENT) return false;
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(PIECE_GLYPH_ORIENTATION_KEY, value);
    return true;
  } catch {
    return false;
  }
}

// Screen-relative degrees. An unknown camera side has no opponent-facing rule.
export function getPieceGlyphRotation({ mode, pieceSide, viewerSide }) {
  if (normalizePieceGlyphOrientationMode(mode) !== FACE_OPPONENT
    || !['red', 'black'].includes(viewerSide)
    || !['red', 'black'].includes(pieceSide)) return 0;
  return pieceSide === viewerSide ? 0 : 180;
}
