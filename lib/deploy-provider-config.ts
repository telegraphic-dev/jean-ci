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

function normalizeDeployment(deployment: Record<string, string>): DeploymentTarget {
  return {
    provider: deployment.provider || 'coolify',
    package: deployment.package || '',
    environment: deployment.environment,
    coolify_app: deployment.coolify_app,
  };
}

export function parseDeploymentConfig(content: string): DeploymentConfigFile {
  const config: DeploymentConfigFile = { deployments: [] };
  let currentDeployment: Record<string, string> | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ')) {
      if (currentDeployment) {
        config.deployments.push(normalizeDeployment(currentDeployment));
      }
      currentDeployment = {};
      const firstPair = trimmed.slice(2);
      if (firstPair.includes(':')) {
        const [key, ...valueParts] = firstPair.split(':');
        currentDeployment[key.trim()] = valueParts.join(':').trim();
      }
      continue;
    }

    if (currentDeployment && trimmed.includes(':')) {
      const [key, ...valueParts] = trimmed.split(':');
      currentDeployment[key.trim()] = valueParts.join(':').trim();
    }
  }

  if (currentDeployment) {
    config.deployments.push(normalizeDeployment(currentDeployment));
  }

  return config;
}

export function findMatchingDeployment(config: DeploymentConfigFile, packageUrl: string, packageName?: string) {
  return config.deployments.find((deployment) => {
    const configPackage = deployment.package.toLowerCase();
    return packageUrl.toLowerCase().includes(configPackage) ||
      configPackage.includes(packageName?.toLowerCase() || '');
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
