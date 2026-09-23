export const PIECE_GLYPH_ORIENTATION_KEY = 'xiangqi.pieceGlyphOrientationMode.v1';
export const ALL_UPRIGHT = 'all-upright';
export const FACE_OPPONENT = 'face-opponent';
export const DEFAULT_PIECE_GLYPH_ORIENTATION_MODE = FACE_OPPONENT;
export const ORIENTATION_HYSTERESIS_DEG = 10;

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

// OrbitControls uses +Y as up and measures spherical azimuth from +Z toward +X.
// The Red player's side of this board is +Z, matching the existing preset azimuths.
export function getLiveBoardAzimuthDeg(cameraPosition, target) {
  const dx = cameraPosition?.x - target?.x;
  const dz = cameraPosition?.z - target?.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || (dx === 0 && dz === 0)) return null;
  return normalizeAngle(Math.atan2(dx, dz) * 180 / Math.PI);
}

export function quantizeBoardOrientation(liveAngleDeg) {
  if (!Number.isFinite(liveAngleDeg)) return null;
  return normalizeAngle(Math.round(normalizeAngle(liveAngleDeg) / 90) * 90);
}

export function updateSnappedBoardOrientation({
  liveAngleDeg, currentSnapDeg, hysteresisDeg = ORIENTATION_HYSTERESIS_DEG,
}) {
  const nearest = quantizeBoardOrientation(liveAngleDeg);
  if (nearest === null) return isQuarterTurn(currentSnapDeg) ? currentSnapDeg : null;
  if (!isQuarterTurn(currentSnapDeg)) return nearest;
  if (nearest === currentSnapDeg) return currentSnapDeg;
  const delta = normalizeAngle(liveAngleDeg - currentSnapDeg + 180) - 180;
  const buffer = Number.isFinite(hysteresisDeg) ? Math.max(0, Math.min(44, hysteresisDeg)) : ORIENTATION_HYSTERESIS_DEG;
  return Math.abs(delta) > 45 + buffer ? nearest : currentSnapDeg;
}

// The existing preset azimuth is the board's screen rotation from Red-bottom.
export function getBoardViewRotationDeg(cameraView) {
  const azimuth = cameraView?.azimuth;
  return Number.isFinite(azimuth) && azimuth % 90 === 0
    ? normalizeAngle(azimuth) : null;
}

// Screen-relative clockwise degrees. Unknown views keep the safe upright fallback.
export function getPieceGlyphRotation({ mode, pieceSide, boardViewRotationDeg }) {
  if (!isQuarterTurn(boardViewRotationDeg) || !['red', 'black'].includes(pieceSide)) return 0;
  const physicalFacing = normalizePieceGlyphOrientationMode(mode) === ALL_UPRIGHT
    ? 0 : pieceSide === 'red' ? 0 : 180;
  return normalizeAngle(physicalFacing - boardViewRotationDeg);
}

// At azimuth -90°, unrotated top-face canvas text appears screen upright.
// Account for the camera/UV basis only when drawing the glyph into its texture.
export function getPieceTextureRotation({ mode, pieceSide, boardViewRotationDeg }) {
  if (!isQuarterTurn(boardViewRotationDeg)) return 0;
  const screenRotation = getPieceGlyphRotation({ mode, pieceSide, boardViewRotationDeg });
  return normalizeAngle(screenRotation - boardViewRotationDeg - 90);
}
