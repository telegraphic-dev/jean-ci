import RepoDetailContent from '../RepoDetailContent';

export default async function RepoSectionPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  return <RepoDetailContent owner={owner} repoName={repo} section="deployments" />;
}
