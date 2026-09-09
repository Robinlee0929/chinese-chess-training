import {
  createReviewCoachStagingCapability,
  installReviewCoachStagingCapability,
} from './review-coach-connectivity.js?v=c9eecddb53';

export function bootstrapReviewCoachStaging(config, dependencies, target = globalThis) {
  const capability = createReviewCoachStagingCapability(config, dependencies);
  return capability && installReviewCoachStagingCapability(capability, target) ? capability : null;
}
