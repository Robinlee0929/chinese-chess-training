export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PHOTO_MIN_ZOOM = 0.5;
export const PHOTO_MAX_ZOOM = 3;
export const PHOTO_ZOOM_STEP = 0.25;
export const PHOTO_SUPPORTED_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

export class PuzzlePhotoError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PuzzlePhotoError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function createPhotoReferenceState(photo = null) {
  return freezeState({
    photo: photo === null ? null : validatePhotoMetadata(photo),
    rotation: 0,
    zoom: 1,
  });
}

export function validatePhotoMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new PuzzlePhotoError('INVALID_METADATA', 'Photo metadata must be an object.');
  }
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  const type = typeof metadata.type === 'string' ? metadata.type.trim().toLowerCase() : '';
  const size = metadata.size;
  if (!PHOTO_SUPPORTED_TYPES.includes(type)) {
    throw new PuzzlePhotoError('UNSUPPORTED_TYPE', 'Only JPEG, PNG, and WebP images are supported.', { type });
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new PuzzlePhotoError('EMPTY_FILE', 'The selected image file is empty.');
  }
  if (size > PHOTO_MAX_BYTES) {
    throw new PuzzlePhotoError('FILE_TOO_LARGE', 'The selected image exceeds the 10 MB preview limit.', { size });
  }
  return Object.freeze({ name: name || '未命名照片', type, size });
}

export function setPhotoReference(state, metadata) {
  requireState(state);
  return freezeState({ photo: validatePhotoMetadata(metadata), rotation: 0, zoom: 1 });
}

export function rotatePhotoRight(state) {
  return withTransform(state, { rotation: normalizeRotation(state.rotation + 90) });
}

export function rotatePhotoLeft(state) {
  return withTransform(state, { rotation: normalizeRotation(state.rotation - 90) });
}

export function setPhotoZoom(state, zoom) {
  requireState(state);
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    throw new PuzzlePhotoError('INVALID_ZOOM', 'Photo zoom must be a finite number.');
  }
  return withTransform(state, { zoom: clampZoom(zoom) });
}

export function zoomPhotoIn(state) {
  requireState(state);
  return setPhotoZoom(state, state.zoom + PHOTO_ZOOM_STEP);
}

export function zoomPhotoOut(state) {
  requireState(state);
  return setPhotoZoom(state, state.zoom - PHOTO_ZOOM_STEP);
}

export function resetPhotoTransform(state) {
  requireState(state);
  return freezeState({ photo: state.photo, rotation: 0, zoom: 1 });
}

export function clearPhotoReference(state) {
  requireState(state);
  return createPhotoReferenceState();
}

export function exportPhotoReferenceState(state) {
  requireState(state);
  return cloneState(state);
}

function withTransform(state, updates) {
  requireState(state);
  return freezeState({ ...state, ...updates });
}

function normalizeRotation(rotation) {
  return ((rotation % 360) + 360) % 360;
}

function clampZoom(zoom) {
  return Math.min(PHOTO_MAX_ZOOM, Math.max(PHOTO_MIN_ZOOM, zoom));
}

function requireState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Number.isFinite(state.rotation) || !Number.isFinite(state.zoom)
    || state.zoom < PHOTO_MIN_ZOOM || state.zoom > PHOTO_MAX_ZOOM
    || (state.photo !== null && (!state.photo || typeof state.photo !== 'object'))) {
    throw new PuzzlePhotoError('INVALID_STATE', 'Invalid photo reference state.');
  }
}

function cloneState(state) {
  return {
    photo: state.photo ? { ...state.photo } : null,
    rotation: state.rotation,
    zoom: state.zoom,
  };
}

function freezeState(state) {
  const cloned = cloneState(state);
  if (cloned.photo) Object.freeze(cloned.photo);
  return Object.freeze(cloned);
}
