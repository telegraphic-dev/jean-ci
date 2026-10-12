export function shouldQueueDraftPRReview(input: {
  draftReviewed: boolean;
  lastReviewedSha?: string;
  headSha: string;
}): boolean {
  return !input.draftReviewed || input.lastReviewedSha !== input.headSha;
}
