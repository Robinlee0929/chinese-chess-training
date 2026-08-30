import { ROWS, COLS, RED, BLACK } from './game.js?v=77efa9c15c';

export const RECOGNITION_OCCUPANCY_EMPTY = 'empty';
export const RECOGNITION_OCCUPANCY_OCCUPIED = 'occupied';
export const RECOGNITION_OCCUPANCY_UNCERTAIN = 'uncertain';
export const RECOGNITION_SIDE_UNKNOWN = 'unknown';
export const RECOGNITION_PATCH_RADIUS_FRACTION = 0.40;
export const RECOGNITION_VERSION = 1;

const OCCUPANCIES = new Set([
  RECOGNITION_OCCUPANCY_EMPTY,
  RECOGNITION_OCCUPANCY_OCCUPIED,
  RECOGNITION_OCCUPANCY_UNCERTAIN,
]);
const SIDES = new Set([RED, BLACK]);
const SUGGESTED_SIDES = new Set([RED, BLACK, RECOGNITION_SIDE_UNKNOWN]);
const PIECE_TYPES = new Set(['K', 'A', 'B', 'N', 'R', 'C', 'P']);

export class PuzzlePhotoRecognitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PuzzlePhotoRecognitionError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function derivePatchRadius(width, height, fraction = RECOGNITION_PATCH_RADIUS_FRACTION) {
  requireDimensions(width, height);
  if (!Number.isFinite(fraction) || fraction < 0.15 || fraction > 0.42) {
    fail('INVALID_PATCH_FRACTION', 'Patch radius fraction must be between 0.15 and 0.42.');
  }
  const spacing = Math.min((width - 1) / (COLS - 1), (height - 1) / (ROWS - 1));
  return Math.max(2, Math.floor(spacing * fraction));
}

export function extractPatchFeatures(pixelBuffer, point, options = {}) {
  const source = requirePixelBuffer(pixelBuffer);
  requirePoint(point);
  const radius = options.radius ?? derivePatchRadius(source.width, source.height);
  if (!Number.isInteger(radius) || radius < 2) {
    fail('INVALID_PATCH_RADIUS', 'Patch radius must be an integer of at least two pixels.');
  }

  const centerX = clamp(Math.round(point.x), 0, source.width - 1);
  const centerY = clamp(Math.round(point.y), 0, source.height - 1);
  const innerLimit = radius * 0.67;
  const axisExclusion = Math.max(1, Math.floor(radius * 0.12));
  const inner = createAccumulator();
  const outer = createAccumulator();
  let edgeTotal = 0;
  let edgeCount = 0;

  for (let y = Math.max(0, centerY - radius); y <= Math.min(source.height - 1, centerY + radius); y++) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(source.width - 1, centerX + radius); x++) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > radius) continue;
      const dx = x - centerX;
      const dy = y - centerY;
      if (Math.abs(dx) <= axisExclusion || Math.abs(dy) <= axisExclusion) continue;
      const pixel = readPixel(source, x, y);
      addSample(distance <= innerLimit ? inner : outer, pixel);
      if (x < source.width - 1
        && Math.abs(dx + 1) > axisExclusion
        && Math.hypot(dx + 1, dy) <= radius) {
        edgeTotal += Math.abs(pixel.luminance - readPixel(source, x + 1, y).luminance);
        edgeCount++;
      }
      if (y < source.height - 1
        && Math.abs(dy + 1) > axisExclusion
        && Math.hypot(dx, dy + 1) <= radius) {
        edgeTotal += Math.abs(pixel.luminance - readPixel(source, x, y + 1).luminance);
        edgeCount++;
      }
    }
  }

  if (!inner.count || !outer.count) {
    fail('PATCH_TOO_SMALL', 'Patch does not contain enough pixels for recognition.');
  }
  const innerStats = finishAccumulator(inner);
  const outerStats = finishAccumulator(outer);
  return Object.freeze({
    centerX,
    centerY,
    radius,
    sampleCount: inner.count + outer.count,
    innerLuminance: innerStats.luminance,
    outerLuminance: outerStats.luminance,
    innerStdDev: innerStats.stdDev,
    outerStdDev: outerStats.stdDev,
    luminanceContrast: Math.abs(innerStats.luminance - outerStats.luminance) / 255,
    edgeMean: edgeCount ? edgeTotal / edgeCount / 255 : 0,
    redChroma: innerStats.redChroma,
    darknessDelta: Math.max(0, outerStats.luminance - innerStats.luminance) / 255,
  });
}

export function classifyPatch(features) {
  requireFeatures(features);
  // Physical pieces often have only modest centre/background luminance contrast,
  // especially on warm wood or cloth boards. Their glyph and rim still create a
  // repeatable local edge/texture signal, so weight that evidence before contrast.
  const contrastSignal = clamp01(features.luminanceContrast / 0.12);
  const varianceSignal = clamp01((features.innerStdDev - 8) / 45);
  const edgeSignal = clamp01(features.edgeMean / 0.065);
  const solidContrastSignal = clamp01((features.luminanceContrast - 0.04) / 0.04)
    * clamp01((8 - features.innerStdDev) / 8);
  const occupancyEvidence = clamp01(
    edgeSignal * 0.50 + contrastSignal * 0.30 + varianceSignal * 0.20
      + solidContrastSignal * 0.10,
  );

  let occupancy;
  let occupancyConfidence;
  if (occupancyEvidence <= 0.25) {
    occupancy = RECOGNITION_OCCUPANCY_EMPTY;
    occupancyConfidence = clamp01(0.58 + (0.25 - occupancyEvidence) * 1.2);
  } else if (occupancyEvidence >= 0.65) {
    occupancy = RECOGNITION_OCCUPANCY_OCCUPIED;
    occupancyConfidence = clamp01(0.58 + (occupancyEvidence - 0.65) * 0.8);
  } else {
    occupancy = RECOGNITION_OCCUPANCY_UNCERTAIN;
    occupancyConfidence = clamp01(0.28 + Math.abs(occupancyEvidence - 0.50) * 0.7);
  }

  let suggestedSide = RECOGNITION_SIDE_UNKNOWN;
  let sideConfidence = 0;
  if (occupancy !== RECOGNITION_OCCUPANCY_EMPTY) {
    const redEvidence = clamp01((features.redChroma - 0.055) / 0.22);
    const darkEvidence = clamp01((features.darknessDelta - 0.055) / 0.27)
      * clamp01(1 - features.redChroma / 0.13);
    if (redEvidence >= 0.34 && redEvidence > darkEvidence + 0.12) {
      suggestedSide = RED;
      sideConfidence = clamp01(0.42 + redEvidence * 0.5);
    } else if (darkEvidence >= 0.34 && darkEvidence > redEvidence + 0.12) {
      suggestedSide = BLACK;
      sideConfidence = clamp01(0.42 + darkEvidence * 0.5);
    }
  }

  return Object.freeze({ occupancy, occupancyConfidence, suggestedSide, sideConfidence });
}

export function recognizeIntersections(pixelBuffer, gridIntersections, options = {}) {
  requirePixelBuffer(pixelBuffer);
  requireGrid(gridIntersections);
  const radius = options.radius ?? derivePatchRadius(pixelBuffer.width, pixelBuffer.height);
  const candidates = gridIntersections.map((point) => {
    const features = extractPatchFeatures(pixelBuffer, point, { radius });
    const classification = classifyPatch(features);
    return Object.freeze({
      r: point.r,
      c: point.c,
      displayRow: point.displayRow,
      displayCol: point.displayCol,
      occupancy: classification.occupancy,
      occupancyConfidence: classification.occupancyConfidence,
      suggestedSide: classification.suggestedSide,
      sideConfidence: classification.sideConfidence,
    });
  });
  return Object.freeze(candidates);
}

export function createRecognitionToken({ photoVersion, calibrationVersion } = {}) {
  requireVersion(photoVersion, 'photoVersion');
  requireVersion(calibrationVersion, 'calibrationVersion');
  return Object.freeze({
    recognitionVersion: RECOGNITION_VERSION,
    photoVersion,
    calibrationVersion,
  });
}

export function isRecognitionTokenCurrent(token, versions = {}) {
  if (!token || typeof token !== 'object') return false;
  return token.recognitionVersion === RECOGNITION_VERSION
    && token.photoVersion === versions.photoVersion
    && token.calibrationVersion === versions.calibrationVersion;
}

export function selectionKey(r, c) {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= ROWS || c < 0 || c >= COLS) {
    fail('INVALID_COORDINATE', 'Selection coordinates are outside the board.');
  }
  return `${r},${c}`;
}

export function candidatesToEditorBoard(candidates, selections) {
  requireCandidates(candidates);
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
    fail('INVALID_SELECTIONS', 'Human selections must be an object keyed by board coordinate.');
  }
  const board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  for (const candidate of candidates) {
    const key = selectionKey(candidate.r, candidate.c);
    if (!Object.prototype.hasOwnProperty.call(selections, key)) {
      fail('UNREVIEWED_INTERSECTION', 'Every intersection must be explicitly reviewed.', {
        r: candidate.r,
        c: candidate.c,
      });
    }
    const selection = selections[key];
    if (selection === null) continue;
    requirePiece(selection);
    board[candidate.r][candidate.c] = { side: selection.side, type: selection.type };
  }
  return board;
}

function requirePixelBuffer(pixelBuffer) {
  if (!pixelBuffer || typeof pixelBuffer !== 'object' || Array.isArray(pixelBuffer)) {
    fail('INVALID_PIXEL_BUFFER', 'Pixel buffer must be an object.');
  }
  requireDimensions(pixelBuffer.width, pixelBuffer.height);
  const { data } = pixelBuffer;
  if (!data || typeof data.length !== 'number' || data.length !== pixelBuffer.width * pixelBuffer.height * 4) {
    fail('INVALID_PIXEL_DATA', 'Pixel data length must match width × height × 4.');
  }
  return pixelBuffer;
}

function requireDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) {
    fail('INVALID_DIMENSIONS', 'Pixel dimensions must be integers of at least three pixels.');
  }
}

function requirePoint(point) {
  if (!point || typeof point !== 'object' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    fail('INVALID_POINT', 'Intersection point must contain finite x and y coordinates.');
  }
}

function requireFeatures(features) {
  const names = ['luminanceContrast', 'innerStdDev', 'outerStdDev', 'edgeMean', 'redChroma', 'darknessDelta'];
  if (!features || typeof features !== 'object' || names.some((name) => !Number.isFinite(features[name]))) {
    fail('INVALID_FEATURES', 'Patch features are malformed.');
  }
}

function requireGrid(grid) {
  if (!Array.isArray(grid) || grid.length !== ROWS * COLS) {
    fail('INVALID_GRID', `Recognition requires exactly ${ROWS * COLS} grid intersections.`);
  }
  const seen = new Set();
  for (const point of grid) {
    requirePoint(point);
    const key = selectionKey(point.r, point.c);
    if (seen.has(key)) fail('DUPLICATE_GRID_COORDINATE', 'Grid coordinates must be unique.');
    seen.add(key);
  }
}

function requireCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== ROWS * COLS) {
    fail('INVALID_CANDIDATES', `Candidate list must contain exactly ${ROWS * COLS} entries.`);
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const key = selectionKey(candidate?.r, candidate?.c);
    if (seen.has(key)) fail('DUPLICATE_CANDIDATE', 'Candidate coordinates must be unique.');
    seen.add(key);
    if (!OCCUPANCIES.has(candidate.occupancy)
      || !SUGGESTED_SIDES.has(candidate.suggestedSide)
      || !unitInterval(candidate.occupancyConfidence)
      || !unitInterval(candidate.sideConfidence)) {
      fail('INVALID_CANDIDATE', 'Candidate classification is malformed.');
    }
  }
}

function requirePiece(piece) {
  if (!piece || typeof piece !== 'object' || Array.isArray(piece)
    || !SIDES.has(piece.side) || !PIECE_TYPES.has(piece.type)) {
    fail('INVALID_SELECTION', 'Human selection must be empty or an exact red/black piece.');
  }
}

function requireVersion(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    fail('INVALID_VERSION', `${name} must be a non-negative integer.`);
  }
}

function createAccumulator() {
  return { count: 0, luminance: 0, luminanceSquared: 0, redChroma: 0 };
}

function addSample(accumulator, pixel) {
  accumulator.count++;
  accumulator.luminance += pixel.luminance;
  accumulator.luminanceSquared += pixel.luminance ** 2;
  accumulator.redChroma += pixel.redChroma;
}

function finishAccumulator(accumulator) {
  const luminance = accumulator.luminance / accumulator.count;
  const variance = Math.max(0, accumulator.luminanceSquared / accumulator.count - luminance ** 2);
  return {
    luminance,
    stdDev: Math.sqrt(variance),
    redChroma: accumulator.redChroma / accumulator.count,
  };
}

function readPixel(source, x, y) {
  const index = (y * source.width + x) * 4;
  const red = source.data[index];
  const green = source.data[index + 1];
  const blue = source.data[index + 2];
  return {
    luminance: red * 0.2126 + green * 0.7152 + blue * 0.0722,
    redChroma: Math.max(0, red - (green + blue) / 2) / 255,
  };
}

function unitInterval(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function fail(code, message, details) {
  throw new PuzzlePhotoRecognitionError(code, message, details);
}
