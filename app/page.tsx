import Link from 'next/link';

export default function HomePage() {
  return (
    <>
      {/* Hero Section */}
      <div className="relative overflow-hidden py-24 px-4">
        <div className="absolute inset-0 bg-gradient-to-b from-[#b7642b]/8 via-[#9f5522]/5 to-transparent"></div>
        <div className="max-w-3xl mx-auto text-center relative">
          <div className="inline-flex items-center gap-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-full px-4 py-1.5 text-sm text-[var(--text-secondary)] mb-8 shadow-sm">
            <span className="w-2 h-2 rounded-full bg-[var(--green)] animate-pulse"></span>
            GitHub App powered by LLM code review
          </div>
          <h1 className="text-5xl md:text-6xl font-bold tracking-tight mb-6">
            <span className="bg-gradient-to-r from-[#b7642b] to-[#9f5522] bg-clip-text text-transparent">jean-ci</span>
          </h1>
          <p className="text-xl text-[var(--text-secondary)] mb-10 max-w-xl mx-auto leading-relaxed">
            Automated pull request reviews with intelligent code analysis. 
            Catch issues early, maintain quality standards, and ship with confidence.
          </p>
          <Link 
            href="/admin" 
            className="inline-block bg-[var(--accent)] text-[var(--on-accent)] px-8 py-3 rounded-full font-medium hover:bg-[var(--accent-hover)] transition-colors shadow-lg"
          >
            Admin Dashboard →
          </Link>
        </div>
      </div>

      {/* Features */}
      <div className="py-16 px-4 border-t border-[var(--border)]">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 hover:shadow-lg transition-shadow">
              <div className="text-3xl mb-3">🔍</div>
              <h3 className="font-semibold text-lg mb-2">Smart Reviews</h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                LLM-powered code analysis catches security issues, bugs, and incomplete implementations automatically.
              </p>
            </div>
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 hover:shadow-lg transition-shadow">
              <div className="text-3xl mb-3">⚙️</div>
              <h3 className="font-semibold text-lg mb-2">Customizable</h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                Define your own review criteria globally or per-repo. Add custom checks via <code className="text-xs bg-[var(--bg-secondary)] px-1 py-0.5 rounded">.jean-ci/pr-checks/*.md</code>
              </p>
            </div>
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 hover:shadow-lg transition-shadow">
              <div className="text-3xl mb-3">🚀</div>
              <h3 className="font-semibold text-lg mb-2">Auto-Deploy</h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                Trigger Coolify deployments when packages are published. GitHub deployments integration with live status.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="py-8 px-4 text-center text-sm text-[var(--text-muted)] border-t border-[var(--border)] mt-16">
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
