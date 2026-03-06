import { Cron } from 'croner';
import {
  Task,
  TaskExecution,
  getEnabledTasks,
  createTaskExecution,
  updateTaskExecution,
  getTask,
} from './db';

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const DEFAULT_TIMEOUT_SECONDS = parseInt(process.env.TASK_DEFAULT_TIMEOUT_SECONDS || '300', 10);

// Active cron jobs (only used in persistent mode)
const activeJobs = new Map<number, Cron>();

// Task executor functions
async function executeHealthCheck(config: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const { url, method = 'GET', expected_status = 200, expected_body_contains, timeout_ms = 5000, headers = {} } = config;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout_ms);
    
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    const body = await response.text();
    
    if (response.status !== expected_status) {
      return {
        success: false,
        output: `Status: ${response.status}`,
        error: `Expected status ${expected_status}, got ${response.status}`,
      };
    }
    
    if (expected_body_contains && !body.includes(expected_body_contains)) {
      return {
        success: false,
        output: body.substring(0, 500),
        error: `Response body does not contain: ${expected_body_contains}`,
      };
    }
    
    return {
      success: true,
      output: `Status: ${response.status}, Body: ${body.substring(0, 200)}`,
    };
  } catch (error: any) {
    return {
      success: false,
      output: '',
      error: error.message,
    };
  }
}

async function executeWebhook(config: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const { url, method = 'POST', headers = {}, body, expected_status = 200, timeout_ms = 30000 } = config;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout_ms);
    
    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      signal: controller.signal,
    };
    
    if (body && method !== 'GET') {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);
    
    const responseBody = await response.text();
    
    if (response.status !== expected_status) {
      return {
        success: false,
        output: responseBody.substring(0, 500),
        error: `Expected status ${expected_status}, got ${response.status}`,
      };
    }
    
    return {
      success: true,
      output: `Status: ${response.status}\n${responseBody.substring(0, 500)}`,
    };
  } catch (error: any) {
    return {
      success: false,
      output: '',
      error: error.message,
    };
  }
}

async function executeLLMCheck(config: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  const { prompt, data_url, model = 'claude-sonnet' } = config;
  
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    return {
      success: false,
      output: '',
      error: 'OpenClaw gateway not configured',
    };
  }
  
  try {
    // Fetch data if data_url provided
    let dataContext = '';
    if (data_url) {
      const dataResponse = await fetch(data_url);
      if (dataResponse.ok) {
        dataContext = await dataResponse.text();
      }
    }
    
    const fullPrompt = dataContext 
      ? `${prompt}\n\n## Data:\n${dataContext.substring(0, 10000)}`
      : prompt;
    
    const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a monitoring assistant. Analyze the data and report any issues. Start your response with PASS: or FAIL: followed by a brief explanation.' },
          { role: 'user', content: fullPrompt },
        ],
        max_tokens: 1000,
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, output: '', error: `LLM API error: ${error}` };
    }
    
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    
    const isPassing = content.toUpperCase().startsWith('PASS:');
    
    return {
      success: isPassing,
      output: content,
      error: isPassing ? undefined : 'LLM check returned FAIL',
    };
  } catch (error: any) {
    return { success: false, output: '', error: error.message };
  }
}

async function executeCommand(config: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> {
  // For now, command execution is not supported in Next.js environment
  // This would need to be delegated to an external runner or container
  return {
    success: false,
    output: '',
    error: 'Command execution not supported in serverless environment. Use webhook or health_check instead.',
  };
}

// Main task executor
export async function executeTask(task: Task, trigger: 'cron' | 'manual' | 'webhook' = 'cron'): Promise<TaskExecution> {
  console.log(`[Task] Starting ${task.name} (${task.task_type})`);
  
  const execution = await createTaskExecution(task.id, trigger);
  
  let result: { success: boolean; output: string; error?: string };
  
  try {
    switch (task.task_type) {
      case 'health_check':
        result = await executeHealthCheck(task.config);
        break;
      case 'webhook':
        result = await executeWebhook(task.config);
        break;
      case 'llm_check':
        result = await executeLLMCheck(task.config);
        break;
      case 'command':
        result = await executeCommand(task.config);
        break;
      default:
        result = { success: false, output: '', error: `Unknown task type: ${task.task_type}` };
    }
  } catch (error: any) {
    result = { success: false, output: '', error: error.message };
  }
  
  const updatedExecution = await updateTaskExecution(execution.id, {
    status: result.success ? 'success' : 'failure',
    output: result.output,
    error: result.error,
  });
  
  console.log(`[Task] ${task.name} completed: ${result.success ? 'SUCCESS' : 'FAILURE'}`);
  
  // Send notification on failure
  if (!result.success && task.notify_on_failure && task.notify_session) {
    await sendFailureNotification(task, result.error || 'Unknown error');
  }
  
  return updatedExecution!;
}

async function sendFailureNotification(task: Task, error: string) {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN || !task.notify_session) {
    return;
  }
  
  const message = `⚠️ **Scheduled Task Failed**

**Task:** ${task.name}
**Type:** ${task.task_type}
**Repo:** ${task.repo || 'Global'}
**Error:** ${error}

Check the task dashboard for details.`;

  try {
    await fetch(`${OPENCLAW_GATEWAY_URL}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        sessionKey: task.notify_session,
        message,
      }),
    });
  } catch (e: any) {
    console.error(`[Task] Failed to send notification: ${e.message}`);
  }
}

// Validate cron expression
function isValidCron(expression: string): boolean {
  try {
    new Cron(expression, { maxRuns: 0 });
    return true;
  } catch {
    return false;
  }
}

// Schedule a single task (persistent mode only)
export function scheduleTask(task: Task) {
  if (!task.enabled) return;
  
  // Cancel existing job if any
  if (activeJobs.has(task.id)) {
    activeJobs.get(task.id)!.stop();
    activeJobs.delete(task.id);
  }
  
  if (!isValidCron(task.cron_expression)) {
    console.error(`[Task] Invalid cron expression for ${task.name}: ${task.cron_expression}`);
    return;
  }
  
  const job = new Cron(task.cron_expression, async () => {
    // Re-fetch task to get latest config
    const currentTask = await getTask(task.id);
    if (!currentTask || !currentTask.enabled) {
      return;
    }
    await executeTask(currentTask, 'cron');
  });
  
  activeJobs.set(task.id, job);
  console.log(`[Task] Scheduled ${task.name} with cron: ${task.cron_expression}`);
}

// Unschedule a task
export function unscheduleTask(taskId: number) {
  if (activeJobs.has(taskId)) {
    activeJobs.get(taskId)!.stop();
    activeJobs.delete(taskId);
    console.log(`[Task] Unscheduled task ${taskId}`);
  }
}

// Initialize all scheduled tasks (persistent mode only)
export async function initTaskRunner() {
  if (process.env.TASK_RUNNER_ENABLED !== 'true') {
    console.log('[Task] Task runner disabled');
    return;
  }
  
  console.log('[Task] Initializing task runner...');
  
  const tasks = await getEnabledTasks();
  for (const task of tasks) {
    scheduleTask(task);
  }
  
  console.log(`[Task] ${tasks.length} tasks scheduled`);
}

// Get next run time for a cron expression
export function getNextRunTime(cronExpression: string): Date | null {
  try {
    const cron = new Cron(cronExpression, { maxRuns: 0 });
    return cron.nextRun();
  } catch {
    return null;
  }
}

// Get active job count
export function getActiveJobCount(): number {
  return activeJobs.size;
}

// Check which tasks are due to run (serverless mode)
// This is called by an external cron trigger (e.g., Vercel cron, Coolify scheduled task)
export async function checkDueTasks(): Promise<{ executed: number; results: Array<{ task: string; status: string }> }> {
  const tasks = await getEnabledTasks();
  const results: Array<{ task: string; status: string }> = [];
  let executed = 0;

  for (const task of tasks) {
    if (!isValidCron(task.cron_expression)) continue;

    // Check if task should run now
    const cron = new Cron(task.cron_expression, { maxRuns: 0 });
    const nextRun = cron.nextRun();
    const prevRun = cron.previousRun();
    
    if (!prevRun) continue;

    // Get last execution time from database
    const { getLastTaskExecution } = await import('./db');
    const lastExec = await getLastTaskExecution(task.id);
    
    // If never run, or last run was before the most recent scheduled time, run now
    const shouldRun = !lastExec || (lastExec.started_at < prevRun);
    
    if (shouldRun) {
      const execution = await executeTask(task, 'cron');
      results.push({ task: task.name, status: execution.status });
      executed++;
    }
  }

  return { executed, results };
}

// Get all tasks with their next run times
export async function getTaskSchedule(): Promise<Array<{
  id: number;
  name: string;
  cron_expression: string;
  next_run: Date | null;
  enabled: boolean;
}>> {
  const tasks = await getEnabledTasks();
  return tasks.map(task => ({
    id: task.id,
    name: task.name,
    cron_expression: task.cron_expression,
    next_run: getNextRunTime(task.cron_expression),
    enabled: task.enabled,
  }));
}
