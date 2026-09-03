import {
  GAME_REVIEW_COACH_MODEL_PROFILES,
  GAME_REVIEW_COACH_DEFAULT_PROFILE,
} from './game-review-coach.js?v=79cf894baf';

export const COACH_MODEL_PROFILE_STORAGE_KEY = 'chinese-chess-training:coach-model-profile:v1';

// Resolve storage inside the try block: accessing localStorage itself may throw.
// The caller invokes these helpers only when the mock capability is enabled.
export function readCoachModelProfilePreference(getStorage) {
  try {
    const value = getStorage()?.getItem(COACH_MODEL_PROFILE_STORAGE_KEY);
    return typeof value === 'string' && GAME_REVIEW_COACH_MODEL_PROFILES.includes(value)
      ? value : GAME_REVIEW_COACH_DEFAULT_PROFILE;
  } catch {
    return GAME_REVIEW_COACH_DEFAULT_PROFILE;
  }
}

export function writeCoachModelProfilePreference(getStorage, value) {
  if (typeof value !== 'string' || !GAME_REVIEW_COACH_MODEL_PROFILES.includes(value)) return false;
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(COACH_MODEL_PROFILE_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
