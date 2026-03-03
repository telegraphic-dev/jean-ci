import { NextRequest, NextResponse } from 'next/server';
import { getDeploymentPipelinesByRepo } from '@/lib/db';

type Params = { params: Promise<{ sha: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { sha } = await params;
  
  // Get pipelines for openclaw-mentor (test repo)
  const result = await getDeploymentPipelinesByRepo('telegraphic-dev/openclaw-mentor', 1, 50);
  
  // Find the pipeline matching this SHA
  const pipeline = result.items.find(p => p.sha.startsWith(sha) || p.shortSha === sha);
  
  return NextResponse.json({
    searchSha: sha,
    foundPipeline: pipeline || null,
    allPipelines: result.items.slice(0, 10).map(p => ({
      sha: p.shortSha,
      build: p.build.status,
      package: p.package.status,
      deploy: p.deploy.status
    }))
  });
}
