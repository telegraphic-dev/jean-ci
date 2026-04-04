import { redirect } from 'next/navigation';
import EventsContent from './EventsContent';

type SearchParams = Promise<{ page?: string; eventType?: string }>;

export default async function EventsPage({ searchParams }: { searchParams: SearchParams }) {
  const { page, eventType } = await searchParams;
  if (eventType) {
    const target = new URLSearchParams();
    if (page) target.set('page', page);
    const query = target.toString();
    const base = `/admin/events/type/${encodeURIComponent(eventType)}`;
    redirect(query ? `${base}?${query}` : base);
  }

  return <EventsContent />;
}
