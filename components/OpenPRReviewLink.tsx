import Link from 'next/link';

export function OpenPRReviewLink({ title, headSha, latestReviewId, latestReviewIsCurrent }: {
  title: string; headSha: string; latestReviewId?: number | null; latestReviewIsCurrent?: boolean;
}) {
  return <>
    {latestReviewId ? <Link href={`/checks/${latestReviewId}`} className="block truncate text-[var(--accent)] hover:underline font-medium">{title}</Link>
      : <span className="block truncate font-medium">{title}</span>}
    <span className="block mt-1 text-xs text-[var(--text-muted)]">
      {!latestReviewId ? 'No review available' : latestReviewIsCurrent ? 'Latest review for current head' : headSha ? 'Older review · current head not reviewed' : 'Latest stored review · current head unknown'}
    </span>
  </>;
}
