// Real PR reviews are still occasionally finishing just over the 120s mark in
// production, especially after prompt/context growth and a few dead-end file
// reads. Give the agent more headroom so near-complete reviews do not get
// marked neutral a second before they would have returned a result.
export const REVIEW_AGENT_WAIT_TIMEOUT_MS = 180_000;

// Keep the transport timeout slightly above the review wait timeout so
// `agent.wait` can return its own timeout result instead of being cut off by
// the WebSocket request deadline first.
export const GATEWAY_RPC_REQUEST_TIMEOUT_MS = REVIEW_AGENT_WAIT_TIMEOUT_MS + 10_000;
