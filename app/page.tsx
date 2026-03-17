import Link from 'next/link';

export default function HomePage() {
  return (
    <>
      <div className="relative overflow-hidden px-4 py-24">
        <div className="absolute inset-0 bg-gradient-to-b from-[#D16640]/8 via-[#874534]/5 to-transparent" />
        <div className="relative mx-auto max-w-3xl text-center">
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-4 py-1.5 text-sm text-[var(--text-secondary)] shadow-sm">
            <span className="h-2 w-2 rounded-full bg-[var(--success)]" />
            GitHub App powered by LLM code review
          </div>
          <h1 className="mb-6 text-5xl font-bold tracking-tight md:text-6xl">
            <span className="bg-gradient-to-r from-[#D16640] to-[#874534] bg-clip-text text-transparent">jean-ci</span>
          </h1>
          <p className="mx-auto mb-10 max-w-xl text-xl leading-relaxed text-[var(--text-secondary)]">
            Automated pull request reviews with intelligent code analysis. Catch issues early, maintain quality standards, and ship with confidence.
          </p>
          <Link
            href="/admin"
            className="inline-block rounded-full bg-[var(--accent)] px-8 py-3 font-medium text-[var(--on-accent)] shadow-lg transition-colors hover:bg-[var(--accent-hover)]"
          >
            Admin Dashboard →
          </Link>
        </div>
      </div>

      <div className="border-t border-[var(--border)] px-4 py-16">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-6 md:grid-cols-3">
            <div className="glass sea-outline rounded-2xl p-6 transition-shadow hover:shadow-lg">
              <h3 className="mb-2 text-lg font-semibold">Smart Reviews</h3>
              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                LLM-powered code analysis catches security issues, bugs, and incomplete implementations automatically.
              </p>
            </div>
            <div className="glass sea-outline rounded-2xl p-6 transition-shadow hover:shadow-lg">
              <h3 className="mb-2 text-lg font-semibold">Customizable</h3>
              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                Define review criteria globally or per repository. Add custom checks via <code className="rounded bg-[var(--bg-secondary)] px-1 py-0.5 text-xs">.jean-ci/pr-checks/*.md</code>
              </p>
            </div>
            <div className="glass sea-outline rounded-2xl p-6 transition-shadow hover:shadow-lg">
              <h3 className="mb-2 text-lg font-semibold">Auto-Deploy</h3>
              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                Trigger Coolify deployments when packages are published. GitHub deployments integration with live status.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-16 border-t border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
        <p>
          jean-ci v0.13.0
          {process.env.NEXT_PUBLIC_COMMIT_SHA && process.env.NEXT_PUBLIC_COMMIT_SHA !== 'unknown' && (
            <span className="text-[var(--text-muted)]"> · {process.env.NEXT_PUBLIC_COMMIT_SHA}</span>
          )}
          <span className="text-[var(--text-muted)]"> · Part of the OpenClaw ecosystem</span>
        </p>
      </div>
    </>
  );
}
