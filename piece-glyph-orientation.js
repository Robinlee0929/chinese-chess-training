export const PIECE_GLYPH_ORIENTATION_KEY = 'xiangqi.pieceGlyphOrientationMode.v1';
export const ALL_UPRIGHT = 'all-upright';
export const FACE_OPPONENT = 'face-opponent';
export const DEFAULT_PIECE_GLYPH_ORIENTATION_MODE = FACE_OPPONENT;

export function normalizePieceGlyphOrientationMode(value) {
  return value === ALL_UPRIGHT ? ALL_UPRIGHT : DEFAULT_PIECE_GLYPH_ORIENTATION_MODE;
}

export function readPieceGlyphOrientationMode(getStorage) {
  try {
    return normalizePieceGlyphOrientationMode(getStorage()?.getItem(PIECE_GLYPH_ORIENTATION_KEY));
  } catch {
    return DEFAULT_PIECE_GLYPH_ORIENTATION_MODE;
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
