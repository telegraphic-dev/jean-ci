import { NextRequest, NextResponse } from 'next/server';
import { getRepo, syncRepoTasks, TaskType } from '@/lib/db';
import { getInstallationOctokit } from '@/lib/github';
import { requireAuth } from '@/lib/auth';

// POST /api/tasks/sync - Sync tasks from a repo's .jean-ci/tasks.yml
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { repo } = body;

    if (!repo || typeof repo !== 'string' || !repo.includes('/')) {
      return NextResponse.json(
        { error: 'Invalid repo format. Expected: owner/repo' },
        { status: 400 }
      );
    }

    const repoConfig = await getRepo(repo);
    if (!repoConfig) {
      return NextResponse.json(
        { error: 'Repository not found in jean-ci' },
        { status: 404 }
      );
    }

    const [owner, repoName] = repo.split('/');
    const octokit = await getInstallationOctokit(repoConfig.installation_id);

    // Fetch tasks.yml from repo
    let tasksContent: string;
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo: repoName,
        path: '.jean-ci/tasks.yml',
      });
      tasksContent = Buffer.from((data as any).content, 'base64').toString('utf8');
    } catch (e: any) {
      if (e.status === 404) {
        // No tasks.yml - delete all repo tasks
        const result = await syncRepoTasks(repo, []);
        return NextResponse.json({
          message: 'No tasks.yml found, cleared repo tasks',
          ...result,
        });
      }
      throw e;
    }

    // Parse YAML (simple parser)
    const tasks = parseTasksYaml(tasksContent);

    // Sync to database
    const result = await syncRepoTasks(repo, tasks);

    return NextResponse.json({
      message: 'Tasks synced successfully',
      ...result,
      tasks_found: tasks.length,
    });
  } catch (error: any) {
    console.error('Error syncing tasks:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Simple YAML parser for tasks.yml
function parseTasksYaml(content: string): Array<{
  name: string;
  cron: string;
  type: TaskType;
  config: Record<string, any>;
}> {
  const tasks: Array<{
    name: string;
    cron: string;
    type: TaskType;
    config: Record<string, any>;
  }> = [];

  let currentTask: any = null;
  let inConfig = false;
  let configIndent = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.search(/\S/);

    // New task starts with "- name:"
    if (trimmed.startsWith('- name:')) {
      if (currentTask && currentTask.name && currentTask.cron && currentTask.type) {
        tasks.push(currentTask);
      }
      currentTask = {
        name: trimmed.replace('- name:', '').trim().replace(/^["']|["']$/g, ''),
        cron: '',
        type: 'health_check' as TaskType,
        config: {},
      };
      inConfig = false;
      continue;
    }

    if (!currentTask) continue;

    // Parse task fields
    if (trimmed.startsWith('cron:')) {
      currentTask.cron = trimmed.replace('cron:', '').trim().replace(/^["']|["']$/g, '');
      inConfig = false;
    } else if (trimmed.startsWith('type:')) {
      currentTask.type = trimmed.replace('type:', '').trim() as TaskType;
      inConfig = false;
    } else if (trimmed.startsWith('config:')) {
      inConfig = true;
      configIndent = indent + 2;
    } else if (inConfig && indent >= configIndent && trimmed.includes(':')) {
      // Parse config key-value
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.substring(0, colonIdx).trim();
      let value: any = trimmed.substring(colonIdx + 1).trim();
      
      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Parse numbers
      else if (/^\d+$/.test(value)) {
        value = parseInt(value, 10);
      }
      // Parse booleans
      else if (value === 'true') value = true;
      else if (value === 'false') value = false;

      currentTask.config[key] = value;
    } else if (!trimmed.startsWith('-')) {
      inConfig = false;
    }
  }

  // Don't forget the last task
  if (currentTask && currentTask.name && currentTask.cron && currentTask.type) {
    tasks.push(currentTask);
  }

  return tasks;
}
