import {
  createReviewCoachStagingCapability,
  installReviewCoachStagingCapability,
} from './review-coach-connectivity.js?v=356f6af929';

export function bootstrapReviewCoachStaging(config, dependencies, target = globalThis) {
  const capability = createReviewCoachStagingCapability(config, dependencies);
  return capability && installReviewCoachStagingCapability(capability, target) ? capability : null;
}
