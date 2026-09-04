import {
  showReviewCoachStagingFailure,
  startReviewCoachStagingApp,
} from './review-coach-bootstrap.js';

startReviewCoachStagingApp().catch(() => showReviewCoachStagingFailure(document));
