import { APP_BASE_URL, COOLIFY_DASHBOARD_URL, buildRepoAppUrl } from './config.ts';
import { getCoolifyAppDetails, triggerCoolifyDeploy } from './coolify.ts';
import {
  type DeploymentConfigFile,
  type DeploymentTarget,
  findMatchingDeployment,
  parseDeploymentConfig,
  validateDeploymentTarget,
} from './deploy-provider-config.ts';

export { findMatchingDeployment, validateDeploymentTarget } from './deploy-provider-config.ts';
export type { DeploymentConfigFile, DeploymentTarget } from './deploy-provider-config.ts';

export interface DeployContext {
  owner: string;
  repo: string;
  packageUrl: string;
  packageName?: string;
}

export interface DeployResult {
  success: boolean;
  provider: string;
  environment: string;
  appUrl?: string;
  logsUrl?: string;
  deploymentUuid?: string;
  appUuid?: string;
  appName?: string;
  error?: string;
}

export interface DeploymentProvider {
  id: string;
  validate(target: DeploymentTarget): string[];
  trigger(target: DeploymentTarget, context: DeployContext): Promise<DeployResult>;
}

export async function fetchDeploymentConfig(octokit: any, owner: string, repo: string, ref = 'main') {
  const candidates = ['.jean-ci/deployments.yml', '.jean-ci/coolify.yml'];

  for (const path of candidates) {
    let content: string | null = null;
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner, repo, path, ref,
      });
      content = Buffer.from(data.content, 'base64').toString('utf8');
    } catch (e: any) {
      if (e.status !== 404) {
        console.error(`Error fetching ${path}:`, e.message);
      }
      continue;
    }

    try {
      return parseDeploymentConfig(content);
    } catch (e: any) {
      console.error(`Invalid deployment config in ${path}: ${e.message}`);
      return null;
    }
  }

  return null;
}

const coolifyProvider: DeploymentProvider = {
  id: 'coolify',
  validate(target) {
    return validateDeploymentTarget(target);
  },
  async trigger(target, context) {
    const environment = target.environment || 'production';
    const appUuid = target.coolify_app!;
    const appDetails = await getCoolifyAppDetails(appUuid);
    const appUrl = appDetails?.fqdn || buildRepoAppUrl(context.repo);
    const coolifyDashboard = COOLIFY_DASHBOARD_URL || APP_BASE_URL;
    const logsUrl = `${coolifyDashboard}/project/${appDetails?.projectUuid || 'default'}/${appDetails?.environmentName || 'production'}/application/${appUuid}`;

    const result = await triggerCoolifyDeploy(appUuid);
    if (!result.success) {
      return {
        success: false,
        provider: 'coolify',
        environment,
        appUrl,
        logsUrl,
        appUuid,
        appName: appDetails?.name,
        error: result.error,
      };
    }

    return {
      success: true,
      provider: 'coolify',
      environment,
      appUrl,
      logsUrl,
      deploymentUuid: result.deploymentUuid,
      appUuid,
      appName: appDetails?.name,
    };
  },
};

const noopProvider: DeploymentProvider = {
  id: 'noop',
  validate(target) {
    return validateDeploymentTarget(target);
  },
  async trigger(target) {
    return {
      success: true,
      provider: 'noop',
      environment: target.environment || 'review-only',
      appUrl: APP_BASE_URL,
      logsUrl: APP_BASE_URL,
    };
  },
};

const providers: Record<string, DeploymentProvider> = {
  coolify: coolifyProvider,
  noop: noopProvider,
};

export function getDeploymentProvider(providerId: string): DeploymentProvider | null {
  return providers[providerId] || null;
}
