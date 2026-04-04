import { redirect } from 'next/navigation';

export default async function RepoBasePage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  redirect(`/admin/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/sessions`);
}
