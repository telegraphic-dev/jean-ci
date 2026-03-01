import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getReposWithPRReviewEnabled, getLatestCheckForPR, OpenPR } from '@/lib/db';
import { getInstallationOctokit } from '@/lib/github';

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  try {
    // Get all repos with PR review enabled
    const repos = await getReposWithPRReviewEnabled();
    
    // Fetch open PRs from each repo
    const allPRs: OpenPR[] = [];
    
    for (const repo of repos) {
      try {
        const octokit = await getInstallationOctokit(repo.installation_id);
        const [owner, repoName] = repo.full_name.split('/');
        
        const { data: prs } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
          owner,
          repo: repoName,
          state: 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: 30,
        });
        
        for (const pr of prs) {
          // Get our latest check status from DB
          const check = await getLatestCheckForPR(repo.full_name, pr.number);
          
          let checkStatus: 'pending' | 'success' | 'failure' = 'pending';
          if (check) {
            if (check.status === 'completed') {
              checkStatus = check.conclusion === 'success' ? 'success' : 'failure';
            } else {
              checkStatus = 'pending';
            }
          }
          
          allPRs.push({
            repo: repo.full_name,
            number: pr.number,
            title: pr.title,
            author: pr.user?.login || 'unknown',
            headSha: pr.head.sha.substring(0, 7),
            url: pr.html_url,
            checkStatus,
            updatedAt: pr.updated_at,
          });
        }
      } catch (error) {
        console.error(`Failed to fetch PRs for ${repo.full_name}:`, error);
      }
    }
    
    // Sort by updated date
    allPRs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    
    // Paginate
    const total = allPRs.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const items = allPRs.slice(offset, offset + limit);
    
    return NextResponse.json({ items, total, page, limit, totalPages });
  } catch (error) {
    console.error('Failed to fetch PRs:', error);
    return NextResponse.json({ error: 'Failed to fetch PRs' }, { status: 500 });
  }
}
