import { redirect } from 'next/navigation';

type SearchParams = Promise<{ tab?: string; checksPage?: string; deploymentsPage?: string; eventsPage?: string }>;

export default async function RepoBasePage({ params, searchParams }: { params: Promise<{ owner: string; repo: string }>; searchParams: SearchParams }) {
  const { owner, repo } = await params;
  const { tab, checksPage, deploymentsPage, eventsPage } = await searchParams;
  const targetSection = tab === 'checks' || tab === 'deployments' || tab === 'tasks' || tab === 'events' || tab === 'sessions'
    ? tab
    : 'sessions';

  const target = new URLSearchParams();
  if (targetSection === 'checks' && checksPage) target.set('checksPage', checksPage);
  if (targetSection === 'deployments' && deploymentsPage) target.set('deploymentsPage', deploymentsPage);
  if (targetSection === 'events' && eventsPage) target.set('eventsPage', eventsPage);

  const query = target.toString();
  const base = `/admin/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${targetSection}`;
  redirect(query ? `${base}?${query}` : base);
}
