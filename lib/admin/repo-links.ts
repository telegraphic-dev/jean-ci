export function getRepoAdminPath(repoFullName: string, section?: string) {
  const separatorIndex = repoFullName.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === repoFullName.length - 1) {
    return '/admin/repos';
  }

  const owner = repoFullName.slice(0, separatorIndex);
  const repo = repoFullName.slice(separatorIndex + 1);
  if (!owner || !repo) {
    return '/admin/repos';
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const base = `/admin/repos/${encodedOwner}/${encodedRepo}`;
  const targetSection = section ?? 'sessions';

  return `${base}/${targetSection}`;
}
