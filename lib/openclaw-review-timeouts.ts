export const REVIEW_AGENT_WAIT_TIMEOUT_MS = 120_000;

// Keep the transport timeout slightly above the review wait timeout so
// `agent.wait` can return its own timeout result instead of being cut off by
// the WebSocket request deadline first.
export const GATEWAY_RPC_REQUEST_TIMEOUT_MS = REVIEW_AGENT_WAIT_TIMEOUT_MS + 10_000;
