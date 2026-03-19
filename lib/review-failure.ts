export function buildExecutionFailureOutcome(errorType: 'gateway' | 'unknown', error: string): {
  conclusion: 'neutral' | 'failure';
  title: string;
  summary: string;
} {
  if (errorType === 'gateway') {
    return {
      conclusion: 'neutral',
      title: '⚠️ Review unavailable',
      summary: `OpenClaw gateway remained unavailable after retries.\n\nThis check was marked neutral so CI does not block merge on gateway downtime.\n\n- ${error}`,
    };
  }

  return {
    conclusion: 'failure',
    title: '❌ Review failed',
    summary: `Reviewer execution failed.\n\n- ${error}`,
  };
}
