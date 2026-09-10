import {
  createReviewCoachStagingCapability,
  installReviewCoachStagingCapability,
} from './review-coach-connectivity.js?v=a0cadeb326';

export function bootstrapReviewCoachStaging(config, dependencies, target = globalThis) {
  const capability = createReviewCoachStagingCapability(config, dependencies);
  return capability && installReviewCoachStagingCapability(capability, target) ? capability : null;
}
