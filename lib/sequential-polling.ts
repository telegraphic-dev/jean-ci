// Share a pending refresh between scheduled polling and an action's readback.
export function singleFlight(refresh: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) pending = Promise.resolve().then(refresh).finally(() => { pending = undefined; });
    return pending;
  };
}

// Delay starts after completion, not after dispatch. Slow responses cannot build
// a backlog of requests waiting on the same database lock.
export function startSequentialPolling(refresh: () => Promise<void>, interval: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    try { await refresh(); } catch { /* The refresh owns user-visible errors. */ }
    finally { if (!stopped) timer = setTimeout(() => { void tick(); }, interval); }
  }
  void tick();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
