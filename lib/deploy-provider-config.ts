import { parse as parseYaml } from 'yaml';

export interface DeploymentTarget {
  provider: string;
  package: string;
  environment?: string;
  coolify_app?: string;
}

export interface DeploymentConfigFile {
  deployments: DeploymentTarget[];
}

export const KNOWN_DEPLOYMENT_PROVIDERS = ['coolify', 'noop'] as const;

function normalizeDeployment(deployment: unknown): DeploymentTarget {
  const source = (deployment && typeof deployment === 'object') ? deployment as Record<string, unknown> : {};

  return {
    provider: typeof source.provider === 'string' && source.provider.trim() ? source.provider.trim() : 'coolify',
    package: typeof source.package === 'string' ? source.package.trim() : '',
    environment: typeof source.environment === 'string' && source.environment.trim() ? source.environment.trim() : undefined,
    coolify_app: typeof source.coolify_app === 'string' && source.coolify_app.trim() ? source.coolify_app.trim() : undefined,
  };
}

export function parseDeploymentConfig(content: string): DeploymentConfigFile {
  const parsed = parseYaml(content) as { deployments?: unknown } | null;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Deployment config must be a YAML object with a deployments array.');
  }

  if (!Array.isArray(parsed.deployments)) {
    throw new Error('Deployment config must define a top-level deployments array.');
  }

  return {
    deployments: parsed.deployments.map(normalizeDeployment),
  };
}

export function findMatchingDeployment(config: DeploymentConfigFile, packageUrl: string, packageName?: string) {
  const normalizedPackageUrl = packageUrl.toLowerCase();
  const normalizedPackageName = packageName?.toLowerCase();

  return config.deployments.find((deployment) => {
    const configPackage = deployment.package.toLowerCase();
    if (normalizedPackageUrl.includes(configPackage)) {
      return true;
    }
    if (normalizedPackageName) {
      return configPackage.includes(normalizedPackageName);
    }
    return false;
  }) || null;
}

export function validateDeploymentTarget(target: DeploymentTarget): string[] {
  const provider = target.provider || 'coolify';
  if (!KNOWN_DEPLOYMENT_PROVIDERS.includes(provider as any)) {
    return [`Unknown deployment provider: ${provider}`];
  }

  const errors: string[] = [];
  if (!target.package) errors.push('package is required');
  if (provider === 'coolify' && !target.coolify_app) {
    errors.push('coolify_app is required for provider=coolify');
  }
  return errors;
}
