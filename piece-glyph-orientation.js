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

const normalizeAngle = (degrees) => ((degrees % 360) + 360) % 360;
const isQuarterTurn = (degrees) => Number.isInteger(degrees) && degrees >= 0
  && degrees < 360 && degrees % 90 === 0;

// The existing preset azimuth is the board's screen rotation from Red-bottom.
export function getBoardViewRotationDeg(cameraView) {
  const azimuth = cameraView?.azimuth;
  return Number.isFinite(azimuth) && azimuth % 90 === 0
    ? normalizeAngle(azimuth) : null;
}

// Screen-relative clockwise degrees. Unknown views keep the safe upright fallback.
export function getPieceGlyphRotation({ mode, pieceSide, boardViewRotationDeg }) {
  if (normalizePieceGlyphOrientationMode(mode) === ALL_UPRIGHT
    || !isQuarterTurn(boardViewRotationDeg)
    || !['red', 'black'].includes(pieceSide)) return 0;
  return normalizeAngle((pieceSide === 'red' ? 0 : 180) - boardViewRotationDeg);
}

// At azimuth -90°, unrotated top-face canvas text appears screen upright.
// Account for the camera/UV basis only when drawing the glyph into its texture.
export function getPieceTextureRotation({ mode, pieceSide, boardViewRotationDeg }) {
  if (!isQuarterTurn(boardViewRotationDeg)) return 0;
  const screenRotation = getPieceGlyphRotation({ mode, pieceSide, boardViewRotationDeg });
  return normalizeAngle(screenRotation - boardViewRotationDeg - 90);
}
