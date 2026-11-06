import {
  createReviewCoachStagingCapability,
  installReviewCoachStagingCapability,
} from './review-coach-connectivity.js?v=e8a9f5c59a';

export function bootstrapReviewCoachStaging(config, dependencies, target = globalThis) {
  const capability = createReviewCoachStagingCapability(config, dependencies);
  return capability && installReviewCoachStagingCapability(capability, target) ? capability : null;
}
