import EventsContent from '../../../events/EventsContent';

export default async function EventTypePage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  return <EventsContent eventType={decodeURIComponent(type)} />;
}
