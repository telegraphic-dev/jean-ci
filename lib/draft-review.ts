export function shouldQueueDraftPRReview(input: {
  draftReviewed: boolean;
  lastReviewedSha?: string;
  webhookHeadSha: string;
  currentHeadSha: string;
}): boolean {
  return input.webhookHeadSha === input.currentHeadSha
    && (!input.draftReviewed || input.lastReviewedSha !== input.webhookHeadSha);
}
