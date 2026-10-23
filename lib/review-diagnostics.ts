import { terminalDiagnostic, validControlId } from './hermes-runs.ts';
import type { RunBinding, RunDiagnostic, HermesRun } from './hermes-runs.ts';

export interface ReviewPartDiagnostic {
  segment: number; status: string; denied: boolean; diagnostic: RunDiagnostic | null;
  source: 'persisted' | 'canonical' | 'unavailable';
}
// Read-only historical hydration: at most four GETs, no observation/decision writes,
// submission, or client-supplied run identities. The route enforces review-admin access.
export async function reviewDiagnostics(check: number, after: number, deps: {
  getCheck: (id: number) => Promise<unknown>;
  getBindings: (id: number) => Promise<RunBinding[]>;
  client: { scope: string; status: (id: string) => Promise<HermesRun> };
}) {
  if (!await deps.getCheck(check)) return null;
  const bindings = (await deps.getBindings(check)).filter(b => b.check_id === check && b.segment > after).sort((a, b) => a.segment - b.segment);
  const page = bindings.slice(0, 4);
  const parts = await Promise.all(page.map(async (b): Promise<ReviewPartDiagnostic> => {
    const base = { segment: b.segment, status: b.status, denied: b.denied };
    if (b.scope !== deps.client.scope) return { ...base, diagnostic: null, source: 'unavailable' };
    if (b.diagnostic) return { ...base, diagnostic: b.diagnostic, source: 'persisted' };
    if (b.run_id && validControlId(b.run_id)) {
      try {
        const run = await deps.client.status(b.run_id);
        const diagnostic = run.run_id === b.run_id ? terminalDiagnostic(run) : null;
        if (diagnostic) return { ...base, diagnostic, source: 'canonical' };
      } catch { /* Historical source can be unavailable; never expose provider errors. */ }
    }
    return { ...base, diagnostic: null, source: 'unavailable' };
  }));
  return { parts, next: bindings.length > page.length ? page.at(-1)!.segment : null };
}
