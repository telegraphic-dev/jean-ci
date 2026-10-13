export function isCurrentReviewHead(reviewHeadSha: string, currentHeadSha?: string | null): boolean {
  return Boolean(currentHeadSha) && reviewHeadSha === currentHeadSha;
}
