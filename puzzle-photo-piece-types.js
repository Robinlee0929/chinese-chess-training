const SIDES = new Set(['red', 'black']);
const PIECE_TYPES = new Set(['K', 'A', 'B', 'N', 'R', 'C', 'P']);
const OCCUPIED = 'occupied';
const DEFAULT_MATRIX_SIZE = 16;
const ROTATIONS = Object.freeze([0, 90, 180, 270]);

export const PIECE_TYPE_THRESHOLDS = Object.freeze({
  minimumSimilarity: 0.55,
  strongSimilarity: 0.7,
  minimumMargin: 0.08,
  minimumConfidence: 0.62,
  maximumAlternatives: 3,
});

export class PuzzlePhotoPieceTypeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PuzzlePhotoPieceTypeError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function normalizePiecePatch(pixelBuffer, point, options = {}) {
  requirePixelBuffer(pixelBuffer);
  requirePoint(point);
  const size = options.size ?? DEFAULT_MATRIX_SIZE;
  const radius = options.radius ?? Math.floor(Math.min(pixelBuffer.width, pixelBuffer.height) / 4);
  if (!Number.isInteger(size) || size < 8 || size > 32) fail('INVALID_MATRIX_SIZE', 'Matrix size must be an integer from 8 to 32.');
  if (!Number.isFinite(radius) || radius < 2) fail('INVALID_PATCH_RADIUS', 'Patch radius must be at least two pixels.');

  // The outer rim is deliberately excluded. This keeps the round piece boundary and
  // board lines from dominating the central character strokes.
  const cropRadius = radius * 0.72;
  const raw = [];
  const weights = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const nx = ((col + 0.5) / size) * 2 - 1;
      const ny = ((row + 0.5) / size) * 2 - 1;
      const distance = Math.hypot(nx, ny);
      const x = point.x + nx * cropRadius;
      const y = point.y + ny * cropRadius;
      raw.push(readLuminance(pixelBuffer, x, y));
      weights.push(distance >= 1 ? 0 : 0.25 + 0.75 * (1 - distance ** 1.7));
    }
  }

  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const mean = raw.reduce((sum, value, index) => sum + value * weights[index], 0) / weightTotal;
  const variance = raw.reduce((sum, value, index) => sum + ((value - mean) ** 2) * weights[index], 0) / weightTotal;
  const deviation = Math.sqrt(Math.max(0, variance));
  const scale = Math.max(8, deviation * 2.6);
  const values = raw.map((value) => clamp01(0.5 + (mean - value) / scale));
  const inkMask = values.map((value, index) => weights[index] > 0 && value >= 0.57 ? 1 : 0);
  const quality = clamp01((deviation - 4) / 38);

  return freezePatch({ size, values, inkMask, weights, quality });
}

export function createTemplateLibrary() {
  return freezeLibrary({ nextId: 1, templates: [] });
}

export function createTemplate(input = {}) {
  if (input.confirmedByHuman !== true) {
    fail('HUMAN_CONFIRMATION_REQUIRED', 'A piece template requires an explicit human confirmation.');
  }
  requireSideAndType(input.side, input.type);
  const patch = copyPatch(input.patch);
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null;
  const sourceKey = typeof input.sourceKey === 'string' && input.sourceKey.trim() ? input.sourceKey.trim() : null;
  return Object.freeze({ id, sourceKey, side: input.side, type: input.type, patch });
}

export function addTemplate(library, input) {
  requireLibrary(library);
  const id = `template-${library.nextId}`;
  const template = createTemplate({ ...input, id });
  return freezeLibrary({ nextId: library.nextId + 1, templates: [...library.templates, template] });
}

export function removeTemplate(library, templateId) {
  requireLibrary(library);
  if (typeof templateId !== 'string' || !templateId) fail('INVALID_TEMPLATE_ID', 'Template ID is required.');
  return freezeLibrary({
    nextId: library.nextId,
    templates: library.templates.filter((template) => template.id !== templateId),
  });
}

export function removeTemplatesForSource(library, sourceKey) {
  requireLibrary(library);
  if (typeof sourceKey !== 'string' || !sourceKey) fail('INVALID_SOURCE_KEY', 'Template source key is required.');
  return freezeLibrary({
    nextId: library.nextId,
    templates: library.templates.filter((template) => template.sourceKey !== sourceKey),
  });
}

export function listTemplates(library) {
  requireLibrary(library);
  return library.templates.map(copyTemplate);
}

export function comparePiecePatches(targetPatch, templatePatch) {
  const target = copyPatch(targetPatch);
  const template = copyPatch(templatePatch);
  if (target.size !== template.size) fail('PATCH_SIZE_MISMATCH', 'Piece patches must use the same matrix size.');
  let best = null;
  for (const rotation of ROTATIONS) {
    const rotated = rotatePatch(template, rotation);
    const score = patchSimilarity(target, rotated);
    if (!best || score > best.score) best = { score, rotation };
  }
  return Object.freeze({ score: round(best.score), rotation: best.rotation });
}

export function rankPieceTypes(targetPatch, library, side, options = {}) {
  requireLibrary(library);
  if (!SIDES.has(side)) return Object.freeze([]);
  const limit = options.limit ?? PIECE_TYPE_THRESHOLDS.maximumAlternatives;
  if (!Number.isInteger(limit) || limit < 1 || limit > 7) fail('INVALID_LIMIT', 'Ranking limit must be from one to seven.');
  const byType = new Map();
  for (const template of library.templates) {
    if (template.side !== side) continue;
    const comparison = comparePiecePatches(targetPatch, template.patch);
    const previous = byType.get(template.type);
    if (!previous || comparison.score > previous.score) {
      byType.set(template.type, {
        side,
        type: template.type,
        score: comparison.score,
        rotation: comparison.rotation,
        templateId: template.id,
        templateQuality: template.patch.quality,
      });
    }
  }
  return Object.freeze([...byType.values()]
    .sort((left, right) => right.score - left.score || left.type.localeCompare(right.type))
    .slice(0, limit)
    .map((entry) => Object.freeze({ ...entry })));
}

export function confidenceForRanking(targetPatch, ranking) {
  const target = copyPatch(targetPatch);
  if (!Array.isArray(ranking) || ranking.length === 0) return 0;
  const best = ranking[0].score;
  const second = ranking[1]?.score ?? 0;
  const separation = clamp01((best - second) / 0.24);
  const quality = clamp01((target.quality + (ranking[0].templateQuality ?? 0)) / 2);
  return round(clamp01(best * 0.5 + separation * 0.35 + quality * 0.15));
}

export function suggestPieceType(targetPatch, library, side, options = {}) {
  const thresholds = { ...PIECE_TYPE_THRESHOLDS, ...(options.thresholds || {}) };
  const alternatives = rankPieceTypes(targetPatch, library, side, {
    limit: options.limit ?? thresholds.maximumAlternatives,
  });
  if (alternatives.length === 0) return freezeSuggestion('unknown', side, null, 0, alternatives);
  const best = alternatives[0];
  const margin = best.score - (alternatives[1]?.score ?? 0);
  const confidence = confidenceForRanking(targetPatch, alternatives);
  let status = 'uncertain';
  let type = best.type;
  if (best.score < thresholds.minimumSimilarity) {
    status = 'unknown';
    type = null;
  } else if (best.score >= thresholds.strongSimilarity
    && margin >= thresholds.minimumMargin
    && confidence >= thresholds.minimumConfidence) {
    status = 'suggested';
  }
  return freezeSuggestion(status, side, type, confidence, alternatives);
}

export function suggestUnresolvedPieceTypes({ candidates, selections, patches, library }) {
  if (!Array.isArray(candidates)) fail('INVALID_CANDIDATES', 'Candidates must be an array.');
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) fail('INVALID_SELECTIONS', 'Selections must be a coordinate map.');
  if (!patches || typeof patches !== 'object' || Array.isArray(patches)) fail('INVALID_PATCHES', 'Patches must be a coordinate map.');
  requireLibrary(library);
  const result = {};
  for (const candidate of candidates) {
    const key = coordinateKey(candidate);
    if (Object.prototype.hasOwnProperty.call(selections, key)) continue;
    if (candidate.occupancy !== OCCUPIED || !Object.prototype.hasOwnProperty.call(patches, key)) continue;
    result[key] = suggestPieceType(patches[key], library, candidate.suggestedSide);
  }
  return Object.freeze(result);
}

export function createPieceTypeSessionToken({ photoVersion, calibrationVersion, recognitionVersion } = {}) {
  for (const [name, value] of Object.entries({ photoVersion, calibrationVersion, recognitionVersion })) {
    if (!Number.isInteger(value) || value < 0) fail('INVALID_VERSION', `${name} must be a non-negative integer.`);
  }
  return Object.freeze({ photoVersion, calibrationVersion, recognitionVersion });
}

export function isPieceTypeSessionCurrent(token, versions = {}) {
  return !!token
    && token.photoVersion === versions.photoVersion
    && token.calibrationVersion === versions.calibrationVersion
    && token.recognitionVersion === versions.recognitionVersion;
}

function patchSimilarity(left, right) {
  let weightTotal = 0;
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < left.values.length; index++) {
    const weight = Math.min(left.weights[index], right.weights[index]);
    weightTotal += weight;
    leftMean += left.values[index] * weight;
    rightMean += right.values[index] * weight;
  }
  leftMean /= weightTotal;
  rightMean /= weightTotal;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  let mse = 0;
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < left.values.length; index++) {
    const weight = Math.min(left.weights[index], right.weights[index]);
    const leftDelta = left.values[index] - leftMean;
    const rightDelta = right.values[index] - rightMean;
    covariance += leftDelta * rightDelta * weight;
    leftVariance += leftDelta ** 2 * weight;
    rightVariance += rightDelta ** 2 * weight;
    mse += (left.values[index] - right.values[index]) ** 2 * weight;
    if (left.inkMask[index] || right.inkMask[index]) union += weight;
    if (left.inkMask[index] && right.inkMask[index]) intersection += weight;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  const correlation = denominator > 1e-9 ? clamp01((covariance / denominator + 1) / 2) : 0.5;
  const mseScore = clamp01(1 - mse / weightTotal / 0.18);
  const overlap = union > 1e-9 ? intersection / union : 0.5;
  return clamp01(correlation * 0.5 + mseScore * 0.3 + overlap * 0.2);
}

function rotatePatch(patch, rotation) {
  if (rotation === 0) return patch;
  const { size } = patch;
  const values = Array(size * size);
  const inkMask = Array(size * size);
  const weights = Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let sourceRow;
      let sourceCol;
      if (rotation === 90) [sourceRow, sourceCol] = [size - 1 - col, row];
      else if (rotation === 180) [sourceRow, sourceCol] = [size - 1 - row, size - 1 - col];
      else [sourceRow, sourceCol] = [col, size - 1 - row];
      const destination = row * size + col;
      const source = sourceRow * size + sourceCol;
      values[destination] = patch.values[source];
      inkMask[destination] = patch.inkMask[source];
      weights[destination] = patch.weights[source];
    }
  }
  return freezePatch({ size, values, inkMask, weights, quality: patch.quality });
}

function readLuminance(source, x, y) {
  const left = clamp(Math.floor(x), 0, source.width - 1);
  const top = clamp(Math.floor(y), 0, source.height - 1);
  const right = clamp(left + 1, 0, source.width - 1);
  const bottom = clamp(top + 1, 0, source.height - 1);
  const fx = clamp01(x - Math.floor(x));
  const fy = clamp01(y - Math.floor(y));
  const sample = (px, py) => {
    const index = (py * source.width + px) * 4;
    return source.data[index] * 0.2126 + source.data[index + 1] * 0.7152 + source.data[index + 2] * 0.0722;
  };
  const upper = sample(left, top) * (1 - fx) + sample(right, top) * fx;
  const lower = sample(left, bottom) * (1 - fx) + sample(right, bottom) * fx;
  return upper * (1 - fy) + lower * fy;
}

function freezeSuggestion(status, side, type, confidence, alternatives) {
  return Object.freeze({ status, side: SIDES.has(side) ? side : null, type, confidence, alternatives });
}

function coordinateKey(candidate) {
  if (!candidate || !Number.isInteger(candidate.r) || !Number.isInteger(candidate.c)
    || candidate.r < 0 || candidate.r > 9 || candidate.c < 0 || candidate.c > 8) {
    fail('INVALID_CANDIDATE', 'Candidate coordinates are invalid.');
  }
  return `${candidate.r},${candidate.c}`;
}

function copyTemplate(template) {
  return { id: template.id, sourceKey: template.sourceKey, side: template.side, type: template.type, patch: copyPatch(template.patch) };
}

function copyPatch(patch) {
  if (!patch || typeof patch !== 'object' || !Number.isInteger(patch.size) || patch.size < 1) fail('INVALID_PATCH', 'Normalized piece patch is malformed.');
  const length = patch.size ** 2;
  for (const field of ['values', 'inkMask', 'weights']) {
    if (!Array.isArray(patch[field]) || patch[field].length !== length || patch[field].some((value) => !Number.isFinite(value))) {
      fail('INVALID_PATCH', 'Normalized piece patch is malformed.');
    }
  }
  if (!Number.isFinite(patch.quality) || patch.quality < 0 || patch.quality > 1) fail('INVALID_PATCH', 'Patch quality must be bounded.');
  return freezePatch({
    size: patch.size,
    values: [...patch.values],
    inkMask: [...patch.inkMask],
    weights: [...patch.weights],
    quality: patch.quality,
  });
}

function freezePatch(patch) {
  return Object.freeze({
    size: patch.size,
    values: Object.freeze([...patch.values]),
    inkMask: Object.freeze([...patch.inkMask]),
    weights: Object.freeze([...patch.weights]),
    quality: round(patch.quality),
  });
}

function freezeLibrary(library) {
  return Object.freeze({ nextId: library.nextId, templates: Object.freeze(library.templates.map((template) => Object.freeze(copyTemplate(template)))) });
}

function requireLibrary(library) {
  if (!library || typeof library !== 'object' || !Number.isInteger(library.nextId) || !Array.isArray(library.templates)) {
    fail('INVALID_LIBRARY', 'Template library is malformed.');
  }
  for (const template of library.templates) {
    requireSideAndType(template.side, template.type);
    copyPatch(template.patch);
  }
}

function requirePixelBuffer(pixelBuffer) {
  if (!pixelBuffer || typeof pixelBuffer !== 'object' || !Number.isInteger(pixelBuffer.width)
    || !Number.isInteger(pixelBuffer.height) || pixelBuffer.width < 3 || pixelBuffer.height < 3) {
    fail('INVALID_PIXEL_BUFFER', 'Pixel buffer dimensions are invalid.');
  }
  if (!pixelBuffer.data || pixelBuffer.data.length !== pixelBuffer.width * pixelBuffer.height * 4) {
    fail('INVALID_PIXEL_BUFFER', 'Pixel data length must match width × height × 4.');
  }
}

function requirePoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) fail('INVALID_POINT', 'Patch center must contain finite x and y.');
}

function requireSideAndType(side, type) {
  if (!SIDES.has(side)) fail('INVALID_SIDE', 'Template side must be red or black.');
  if (!PIECE_TYPES.has(type)) fail('INVALID_TYPE', 'Template type must use K, A, B, N, R, C, or P.');
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function fail(code, message, details) {
  throw new PuzzlePhotoPieceTypeError(code, message, details);
}
