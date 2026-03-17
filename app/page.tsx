import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="overflow-hidden">
      <section className="relative px-4 pb-20 pt-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="inline-flex items-center gap-3 rounded-full border border-[var(--border)] bg-white/70 px-4 py-2 text-sm text-[var(--text-secondary)] shadow-sm backdrop-blur">
            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[var(--success)]" />
            OpenClaw ecosystem
          </div>
          <div className="text-sm text-[var(--text-muted)]">Human-first PR reviews</div>
        </div>
        <div className="absolute left-1/2 top-20 h-72 w-72 -translate-x-[180%] rounded-full bg-[var(--accent-soft)]/70 blur-3xl" />
        <div className="absolute right-[-5rem] top-24 h-80 w-80 rounded-full bg-[var(--accent-warm)]/20 blur-3xl" />
        <div className="mx-auto grid max-w-6xl gap-12 pt-14 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div className="relative">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-4 py-1.5 text-sm text-[var(--text-secondary)] shadow-sm backdrop-blur">
              <span className="inline-flex h-2 w-2 rounded-full bg-[var(--accent-warm)]" />
              ClawBuddy-style docs refresh
            </div>
            <h1 className="max-w-4xl text-5xl font-semibold tracking-tight text-[var(--accent-deep)] sm:text-6xl lg:text-7xl">
              A pull request review buddy that speaks like a human.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--text-secondary)] sm:text-xl">
              jean-ci turns GitHub webhooks into clear OpenClaw-powered reviews, repo-specific check pearls, and deployment nudges your team can actually use.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/admin"
                className="inline-flex items-center justify-center rounded-full bg-[var(--accent)] px-7 py-3 text-base font-semibold text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                Open admin tidepool
              </Link>
              <a
                href="#prompt-pearls"
                className="inline-flex items-center justify-center rounded-full border border-[var(--border-strong)] bg-white/70 px-7 py-3 text-base font-semibold text-[var(--accent-deep)] transition-colors hover:bg-white"
              >
                Copy prompt pearls
              </a>
            </div>
            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <div className="glass sea-outline rounded-3xl p-5">
                <div className="text-sm uppercase tracking-[0.24em] text-[var(--text-muted)]">Signal</div>
                <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                  Review output lands as GitHub Checks instead of getting lost in logs.
                </p>
              </div>
              <div className="glass sea-outline rounded-3xl p-5">
                <div className="text-sm uppercase tracking-[0.24em] text-[var(--text-muted)]">Promptable</div>
                <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                  Tune global rules or drop repo-specific markdown into `.jean-ci/pr-checks/`.
                </p>
              </div>
              <div className="glass sea-outline rounded-3xl p-5">
                <div className="text-sm uppercase tracking-[0.24em] text-[var(--text-muted)]">Deploy-aware</div>
                <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                  Restart Coolify workloads when new GHCR images surface.
                </p>
              </div>
            </div>
          </div>
          <div className="relative">
            <div className="shell rounded-[2rem] p-5">
              <div className="mb-4 flex items-center justify-between text-xs uppercase tracking-[0.28em] text-[#8fd8cb]">
                <span>jean-ci starter</span>
                <span>copy/paste friendly</span>
              </div>
              <pre className="text-sm leading-7">
{`# .jean-ci/pr-checks/security.md
Review this PR like a careful security engineer.

Look for:
- auth or permission bypasses
- unsafe input handling
- secret leakage
- new endpoints missing validation

Return only concrete findings.
Include file paths and line numbers.`}
              </pre>
            </div>
            <div className="glass sea-outline absolute -bottom-6 left-6 max-w-xs rounded-3xl p-5">
              <div className="text-sm font-semibold text-[var(--accent-deep)]">What changes for teams</div>
              <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                Less review drift, faster operator setup, and prompts that feel editable instead of magical.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-3">
          <div className="glass sea-outline rounded-[2rem] p-8">
            <div className="text-sm uppercase tracking-[0.22em] text-[var(--text-muted)]">How it flows</div>
            <h2 className="mt-3 text-3xl font-semibold text-[var(--accent-deep)]">Webhook in, review out.</h2>
            <p className="mt-4 text-base leading-7 text-[var(--text-secondary)]">
              jean-ci receives the PR event, assembles the review context, calls OpenClaw, and publishes the answer as GitHub Checks your reviewers can trust.
            </p>
          </div>
          <div className="glass sea-outline rounded-[2rem] p-8">
            <div className="text-sm uppercase tracking-[0.22em] text-[var(--text-muted)]">For operators</div>
            <h2 className="mt-3 text-3xl font-semibold text-[var(--accent-deep)]">One shared current.</h2>
            <p className="mt-4 text-base leading-7 text-[var(--text-secondary)]">
              Keep a global review prompt in the admin UI, then layer repo-specific checks only where the codebase really needs them.
            </p>
          </div>
          <div className="glass sea-outline rounded-[2rem] p-8">
            <div className="text-sm uppercase tracking-[0.22em] text-[var(--text-muted)]">For release lanes</div>
            <h2 className="mt-3 text-3xl font-semibold text-[var(--accent-deep)]">Deploy hooks included.</h2>
            <p className="mt-4 text-base leading-7 text-[var(--text-secondary)]">
              GHCR package publishes can map straight to Coolify restarts, keeping review and release signals in one place.
            </p>
          </div>
        </div>
      </section>

      <section id="prompt-pearls" className="px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <div className="text-sm uppercase tracking-[0.24em] text-[var(--text-muted)]">Prompt pearls</div>
            <h2 className="mt-3 text-4xl font-semibold text-[var(--accent-deep)]">Copyable review prompts, not vague advice.</h2>
            <p className="mt-4 text-lg leading-8 text-[var(--text-secondary)]">
              The best public docs here are the snippets an operator can lift straight into a repository. These examples keep that affordance intact.
            </p>
          </div>
          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <div className="shell rounded-[2rem] p-6">
              <div className="mb-4 text-sm font-semibold uppercase tracking-[0.22em] text-[#8fd8cb]">security.md</div>
              <pre className="text-sm leading-7">
{`Review this pull request like a careful security engineer.

Look for:
- auth or permission bypasses
- unsafe input handling
- secret leakage
- SSRF, XSS, or injection paths

Return only concrete findings.
Include file paths and line numbers.`}
              </pre>
            </div>
            <div className="shell rounded-[2rem] p-6">
              <div className="mb-4 text-sm font-semibold uppercase tracking-[0.22em] text-[#8fd8cb]">tests.md</div>
              <pre className="text-sm leading-7">
{`Review this change for test risk.

Call out:
- new behavior without coverage
- fragile assertions
- mocks that hide regressions
- edge cases the PR now depends on

Prefer a short list of actionable findings.`}
              </pre>
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="glass sea-outline rounded-[2rem] p-8">
            <div className="text-sm uppercase tracking-[0.24em] text-[var(--text-muted)]">Setup tide chart</div>
            <h2 className="mt-3 text-4xl font-semibold text-[var(--accent-deep)]">Get jean-ci live without spelunking.</h2>
            <ol className="mt-6 space-y-4 text-base leading-7 text-[var(--text-secondary)]">
              <li>1. Add the GitHub App credentials and OpenClaw gateway env vars.</li>
              <li>2. Subscribe the app to PR and installation webhooks.</li>
              <li>3. Drop markdown prompts into `.jean-ci/pr-checks/`.</li>
              <li>4. Tune the shared review prompt in `/admin`.</li>
            </ol>
          </div>
          <div className="shell rounded-[2rem] p-6">
            <div className="mb-4 flex items-center justify-between text-sm font-semibold uppercase tracking-[0.22em] text-[#8fd8cb]">
              <span>starter env</span>
              <span>README parity</span>
            </div>
            <pre className="text-sm leading-7">
{`GITHUB_APP_ID=your_app_id
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_APP_PRIVATE_KEY_B64=base64_encoded_private_key

GITHUB_CLIENT_ID=your_oauth_client_id
GITHUB_CLIENT_SECRET=your_oauth_client_secret
ADMIN_GITHUB_ID=your_github_user_id

OPENCLAW_GATEWAY_URL=http://coolify-proxy/openclaw
OPENCLAW_GATEWAY_TOKEN=your_gateway_token
DATA_DIR=/data`}
            </pre>
          </div>
        </div>
      </section>

      <footer className="mt-8 border-t border-[var(--border)] px-4 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 text-sm text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between">
          <p>jean-ci v0.13.0 · part of the OpenClaw ecosystem</p>
          <p>
            {process.env.NEXT_PUBLIC_COMMIT_SHA && process.env.NEXT_PUBLIC_COMMIT_SHA !== 'unknown'
              ? `commit ${process.env.NEXT_PUBLIC_COMMIT_SHA}`
              : 'shipping review pearls through GitHub Checks'}
          </p>
        </div>
      </footer>
    </main>
  );
}
