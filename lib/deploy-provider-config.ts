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

function normalizePackageRef(packageRef: string): string {
  const trimmed = packageRef.trim().toLowerCase();
  const digestIndex = trimmed.indexOf('@');
  const withoutDigest = digestIndex >= 0 ? trimmed.slice(0, digestIndex) : trimmed;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  return hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

function getPackageLeaf(packageRef: string): string {
  const normalized = normalizePackageRef(packageRef);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

export function findMatchingDeployment(config: DeploymentConfigFile, packageUrl: string, packageName?: string) {
  const normalizedPackageUrl = normalizePackageRef(packageUrl);
  const normalizedPackageName = packageName?.trim().toLowerCase();

  return config.deployments.find((deployment) => {
    const configPackage = normalizePackageRef(deployment.package);
    if (normalizedPackageUrl === configPackage) {
      return true;
    }
    if (normalizedPackageName) {
      return getPackageLeaf(configPackage) === normalizedPackageName;
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
