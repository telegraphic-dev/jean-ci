# Readable review output

GitHub reviews show the reviewer’s Markdown findings, not transport verdicts,
segment labels or review profiles. New reviewer instructions request a concise
finding heading and separate Location, Problem and Fix paragraphs. Legacy prose
and one-line findings remain intact; formatting never invents titles or locations.
[The historical example](review-output-example.md) is snapshot-tested from the
supplied reviewer text, without fabricating a missing line number.

Source links use the server-owned repository and exact reviewed SHA. Only supplied
`file:line` references verified against new-side lines in the reviewed diff are
linked. Unknown lines/files, deleted-side locations, Git-quoted paths and references
without line numbers remain plain text. Fenced examples and existing Markdown links
are not rewritten.

The authenticated check page keeps the readable result above collapsed **Review
details**, **Prompt Used** and **Diff Preview** disclosures. Review details contain
persisted reviewer output only, including available segment labels and profiles;
they do not fetch native reasoning, tool arguments or secrets. Historical checks
can only show what was originally stored. A truncated diff preview is explicitly
marked. New PR reviews persist the full normalized output, even when GitHub’s review
body (65,000 characters) or check summary (65,535 characters) needs a bounded preview.
Overflow links point to those persisted details.

Open PR titles link to the newest global **Code Review** for the event’s current
head, with timestamp/ID tie-breaking. When only an older review exists, the link is
explicitly marked older. Missing reviews have no misleading link; missing heads
are marked unknown. The separate GitHub PR link remains external.

## Sign-in return destination

A logged-out check links to `/admin?next=/checks/<id>` (URL-encoded). The login entry
passes a validated path to OAuth initiation, which binds it to the random OAuth
state in the sealed session. Successful callbacks validate nonempty matching state,
retain the existing identity/admin checks, consume the pending state/destination,
and redirect to the configured app origin. Callback `next`, Host and forwarded
headers do not select the destination. Configure `BASE_URL` to the canonical public
app URL, matching the registered GitHub OAuth callback.

Only literal positive-ID check paths and safe `/admin` path segments are accepted;
absolute URLs, protocol-relative URLs, encoded paths, control characters, backslashes,
queries, fragments, traversal and auth-loop destinations are rejected. Unsupported
navigation defaults to `/admin` in the login UI; invalid explicit OAuth-initiation
or stored destinations are rejected by the routes. There are no auth exemptions.

## Verification

```sh
npm test
npm run build
```

The PostgreSQL selection test runs when `READABLE_REVIEW_TEST_DATABASE_URL` points to
an isolated disposable database; it creates and drops only its uniquely named schema.
Without that variable, that one database test is explicitly skipped. Route/component
and OAuth security tests use real route implementations and iron-session cookie
sealing, mocking only external/server boundaries.

For a local browser fixture after building:

```sh
READABLE_REVIEW_TEST_DATABASE_URL=postgres://... \
  node --experimental-strip-types tests/support/local-review-fixture.mjs
```

Open `http://localhost:3197/checks/4934`. The fixture runs the actual production Next
UI on port 3198 behind a local proxy on 3197, uses an isolated PostgreSQL schema,
and substitutes a clearly labeled local identity provider and GitHub token/user
boundary. No production session or credentials are created. Sign in via the fixture
provider to exercise the real callback, cookie and return navigation; then inspect
`/admin/reviews/open`. Stop with Ctrl-C to terminate the owned server and remove its
schema. The fixture does not send reviews or contact GitHub.
