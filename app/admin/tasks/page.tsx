import { redirect } from 'next/navigation';

type SearchParams = Promise<{ view?: string; offset?: string }>;

export default async function TasksPage({ searchParams }: { searchParams: SearchParams }) {
  const { view, offset } = await searchParams;
  const targetView = view === 'events' ? 'events' : 'summary';
  const target = new URLSearchParams();
  if (targetView === 'events' && offset) target.set('offset', offset);
  const query = target.toString();
  redirect(query ? `/admin/tasks/${targetView}?${query}` : `/admin/tasks/${targetView}`);
}
