import { PROFILES, snapshotExact } from './contract.js';

export const DEFAULT_PROFILE_POLICY = Object.freeze({ economy: true, balanced: true, quality: true });

export function validateProfilePolicy(value) {
  const policy = snapshotExact(value, PROFILES);
  return policy && PROFILES.every((id) => typeof policy[id] === 'boolean') ? Object.freeze(policy) : null;
}

export function capabilities(policy) {
  return { version: 1, profiles: PROFILES.map((id) => ({ id, available: policy[id] })), defaultProfile: 'economy' };
}
