import { notFound } from 'next/navigation';
import TasksContent, { type TaskViewMode } from '../TasksContent';

export default async function TaskViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;

  if (view !== 'summary' && view !== 'events') {
    notFound();
  }

  return <TasksContent view={view as TaskViewMode} />;
}
