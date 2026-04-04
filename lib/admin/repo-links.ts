export function getRepoAdminPath(repoFullName: string, section?: string) {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    return '/admin/repos';
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const base = `/admin/repos/${encodedOwner}/${encodedRepo}`;

  return section ? `${base}/${section}` : base;
}
