export const CALIBRATION_ORIENTATION_RED_BOTTOM = 'red-bottom';
export const CALIBRATION_ORIENTATION_RED_TOP = 'red-top';
export const CALIBRATION_CANONICAL_WIDTH = 480;
export const CALIBRATION_CANONICAL_HEIGHT = 540;
export const CALIBRATION_DEFAULT_INSET = 0.08;

export const CALIBRATION_CORNER_NAMES = Object.freeze([
  'topLeft',
  'topRight',
  'bottomRight',
  'bottomLeft',
]);

export class PuzzlePhotoCalibrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PuzzlePhotoCalibrationError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function createCalibrationState(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new PuzzlePhotoCalibrationError('INVALID_OPTIONS', 'Calibration options must be an object.');
  }
  const inset = options.inset ?? CALIBRATION_DEFAULT_INSET;
  if (!Number.isFinite(inset) || inset < 0.02 || inset > 0.35) {
    throw new PuzzlePhotoCalibrationError('INVALID_INSET', 'Calibration inset must be between 0.02 and 0.35.');
  }
  const orientation = requireOrientation(
    options.orientation ?? CALIBRATION_ORIENTATION_RED_BOTTOM,
  );
  return freezeState({
    corners: {
      topLeft: { x: inset, y: inset },
      topRight: { x: 1 - inset, y: inset },
      bottomRight: { x: 1 - inset, y: 1 - inset },
      bottomLeft: { x: inset, y: 1 - inset },
    },
    orientation,
    sideToMove: options.sideToMove ?? null,
  });
}

export function normalizeCorner(point) {
  requirePoint(point, 'INVALID_COORDINATE');
  return Object.freeze({
    x: clamp01(point.x),
    y: clamp01(point.y),
  });
}

export function setCorner(state, cornerName, point) {
  requireState(state);
  requireCornerName(cornerName);
  const corners = cloneCorners(state.corners);
  corners[cornerName] = normalizeCorner(point);
  return freezeState({ ...state, corners });
}

export function setCalibrationOrientation(state, orientation) {
  requireState(state);
  return freezeState({ ...state, orientation: requireOrientation(orientation) });
}

export function resetCalibration(state) {
  requireState(state);
  return createCalibrationState({
    orientation: state.orientation,
    sideToMove: state.sideToMove,
  });
}

export function validateQuadrilateral(input) {
  const corners = readCorners(input);
  for (const name of CALIBRATION_CORNER_NAMES) {
    const point = corners[name];
    requirePoint(point, 'INVALID_COORDINATE');
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      throw new PuzzlePhotoCalibrationError(
        'OUT_OF_BOUNDS',
        `${name} must remain inside the image bounds.`,
        { cornerName: name },
      );
    }
  }

  const points = CALIBRATION_CORNER_NAMES.map((name) => corners[name]);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (distance(points[i], points[j]) < 0.02) {
        throw new PuzzlePhotoCalibrationError(
          'OVERLAPPING_CORNERS',
          'Board corners must not overlap.',
        );
      }
    }
  }

  if (segmentsIntersect(points[0], points[1], points[2], points[3])
    || segmentsIntersect(points[1], points[2], points[3], points[0])) {
    throw new PuzzlePhotoCalibrationError(
      'SELF_INTERSECTION',
      'Board corner edges must not cross.',
    );
  }

  const widths = [distance(points[0], points[1]), distance(points[3], points[2])];
  const heights = [distance(points[0], points[3]), distance(points[1], points[2])];
  if (Math.min(...widths) < 0.05 || Math.min(...heights) < 0.05) {
    throw new PuzzlePhotoCalibrationError(
      'DEGENERATE_QUADRILATERAL',
      'Board calibration must have meaningful width and height.',
    );
  }

  const crosses = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const after = points[(index + 2) % points.length];
    return cross(point, next, after);
  });
  if (crosses.some((value) => value <= 1e-6)) {
    throw new PuzzlePhotoCalibrationError(
      'INVALID_CORNER_ORDER',
      'Corners must remain ordered top-left, top-right, bottom-right, bottom-left.',
    );
  }

  const area = Math.abs(polygonArea(points));
  if (area < 0.01) {
    throw new PuzzlePhotoCalibrationError(
      'DEGENERATE_QUADRILATERAL',
      'Board calibration area is too small.',
    );
  }

  return Object.freeze({ valid: true, area });
}

export function computeHomography(sourceCorners, targetCorners) {
  const source = pointArray(sourceCorners, 'sourceCorners');
  const target = pointArray(targetCorners, 'targetCorners');
  const matrix = [];
  const vector = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = source[i];
    const { x: u, y: v } = target[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const solved = solveLinearSystem(matrix, vector);
  return Object.freeze([...solved, 1]);
}

export function transformPoint(homography, point) {
  if (!Array.isArray(homography) || homography.length !== 9
    || homography.some((value) => !Number.isFinite(value))) {
    throw new PuzzlePhotoCalibrationError('INVALID_HOMOGRAPHY', 'Homography must contain nine finite values.');
  }
  requirePoint(point, 'INVALID_COORDINATE');
  const denominator = homography[6] * point.x + homography[7] * point.y + homography[8];
  if (Math.abs(denominator) < 1e-12) {
    throw new PuzzlePhotoCalibrationError('SINGULAR_TRANSFORM', 'Point cannot be transformed by this homography.');
  }
  return Object.freeze({
    x: (homography[0] * point.x + homography[1] * point.y + homography[2]) / denominator,
    y: (homography[3] * point.x + homography[4] * point.y + homography[5]) / denominator,
  });
}

export function createGridIntersections(
  orientation = CALIBRATION_ORIENTATION_RED_BOTTOM,
  canonicalWidth = CALIBRATION_CANONICAL_WIDTH,
  canonicalHeight = CALIBRATION_CANONICAL_HEIGHT,
) {
  requireOrientation(orientation);
  requireCanonicalSize(canonicalWidth, canonicalHeight);
  const points = [];
  for (let displayRow = 0; displayRow < 10; displayRow++) {
    for (let displayCol = 0; displayCol < 9; displayCol++) {
      const redBottom = orientation === CALIBRATION_ORIENTATION_RED_BOTTOM;
      points.push(Object.freeze({
        r: redBottom ? 9 - displayRow : displayRow,
        c: redBottom ? displayCol : 8 - displayCol,
        displayRow,
        displayCol,
        x: (displayCol / 8) * canonicalWidth,
        y: (displayRow / 9) * canonicalHeight,
      }));
    }
  }
  return Object.freeze(points);
}

export function exportCalibration(
  state,
  canonicalWidth = CALIBRATION_CANONICAL_WIDTH,
  canonicalHeight = CALIBRATION_CANONICAL_HEIGHT,
) {
  requireState(state);
  validateQuadrilateral(state.corners);
  requireCanonicalSize(canonicalWidth, canonicalHeight);
  return {
    corners: cloneCorners(state.corners),
    orientation: state.orientation,
    canonicalWidth,
    canonicalHeight,
    gridIntersections: createGridIntersections(state.orientation, canonicalWidth, canonicalHeight)
      .map((point) => ({ ...point })),
  };
}

function requireState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !state.corners || typeof state.corners !== 'object') {
    throw new PuzzlePhotoCalibrationError('INVALID_STATE', 'Invalid calibration state.');
  }
  requireOrientation(state.orientation);
  for (const name of CALIBRATION_CORNER_NAMES) requirePoint(state.corners[name], 'INVALID_STATE');
}

function requireCanonicalSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PuzzlePhotoCalibrationError('INVALID_CANONICAL_SIZE', 'Canonical dimensions must be positive.');
  }
}

function requireCornerName(name) {
  if (!CALIBRATION_CORNER_NAMES.includes(name)) {
    throw new PuzzlePhotoCalibrationError('INVALID_CORNER_NAME', 'Unknown calibration corner.', { cornerName: name });
  }
}

function requireOrientation(orientation) {
  if (![CALIBRATION_ORIENTATION_RED_BOTTOM, CALIBRATION_ORIENTATION_RED_TOP].includes(orientation)) {
    throw new PuzzlePhotoCalibrationError('INVALID_ORIENTATION', 'Unknown board orientation.', { orientation });
  }
  return orientation;
}

function requirePoint(point, code) {
  if (!point || typeof point !== 'object' || Array.isArray(point)
    || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new PuzzlePhotoCalibrationError(code, 'Corner coordinates must be finite numbers.');
  }
}

function readCorners(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PuzzlePhotoCalibrationError('INVALID_CORNERS', 'Four ordered corners are required.');
  }
  return input.corners && typeof input.corners === 'object' ? input.corners : input;
}

function pointArray(input, label) {
  let points;
  if (Array.isArray(input)) points = input;
  else {
    const corners = readCorners(input);
    points = CALIBRATION_CORNER_NAMES.map((name) => corners[name]);
  }
  if (points.length !== 4) {
    throw new PuzzlePhotoCalibrationError('INVALID_POINT_SET', `${label} must contain exactly four points.`);
  }
  points.forEach((point) => requirePoint(point, 'INVALID_COORDINATE'));
  return points;
}

function solveLinearSystem(sourceMatrix, sourceVector) {
  const matrix = sourceMatrix.map((row, index) => [...row, sourceVector[index]]);
  const size = matrix.length;
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    if (Math.abs(matrix[pivot][col]) < 1e-12) {
      throw new PuzzlePhotoCalibrationError('SINGULAR_TRANSFORM', 'Calibration geometry cannot produce a perspective transform.');
    }
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col];
    for (let j = col; j <= size; j++) matrix[col][j] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let j = col; j <= size; j++) matrix[row][j] -= factor * matrix[col][j];
    }
  }
  return matrix.map((row) => row[size]);
}

function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function polygonArea(points) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function cloneCorners(corners) {
  return Object.fromEntries(CALIBRATION_CORNER_NAMES.map((name) => [name, { ...corners[name] }]));
}

function freezeState(state) {
  const corners = cloneCorners(state.corners);
  for (const point of Object.values(corners)) Object.freeze(point);
  Object.freeze(corners);
  return Object.freeze({
    corners,
    orientation: state.orientation,
    sideToMove: state.sideToMove,
  });
}
