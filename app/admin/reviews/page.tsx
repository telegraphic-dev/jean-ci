import { redirect } from 'next/navigation';

type SearchParams = Promise<{ page?: string }>;

export default async function ReviewsPage({ searchParams }: { searchParams: SearchParams }) {
  const { page } = await searchParams;
  const target = new URLSearchParams();
  if (page) target.set('page', page);
  const query = target.toString();
  redirect(query ? `/admin/reviews/open?${query}` : '/admin/reviews/open');
}
