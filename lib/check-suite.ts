export function handlesCheckSuiteAction(action: string): boolean {
  return action === 'completed' || action === 'rerequested';
}

export function shouldQueueRerequestedReview(prReviewEnabled: boolean | null | undefined): boolean {
  return prReviewEnabled === true;
}

