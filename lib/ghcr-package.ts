import type { DeploymentTarget } from './deploy-provider-config.ts';

export interface GhcrPackageRef {
  owner: string;
  packageName: string;
  packageUrl: string;
}

function stripPackageTagOrDigest(packageRef: string): string {
  const trimmed = packageRef.trim().toLowerCase();
  const digestIndex = trimmed.indexOf('@');
  const withoutDigest = digestIndex >= 0 ? trimmed.slice(0, digestIndex) : trimmed;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

export function parseGhcrPackageRef(packageRef: string): GhcrPackageRef | null {
  const packageUrl = stripPackageTagOrDigest(packageRef);
  const prefix = 'ghcr.io/';
  if (!packageUrl.startsWith(prefix)) return null;

  const path = packageUrl.slice(prefix.length);
  const slashIndex = path.indexOf('/');
  if (slashIndex <= 0 || slashIndex === path.length - 1) return null;

  return {
    owner: path.slice(0, slashIndex),
    packageName: path.slice(slashIndex + 1),
    packageUrl,
  };
}

export function packageVersionMatchesHeadSha(version: any, headSha: string): boolean {
  const shortSha = headSha.slice(0, 7).toLowerCase();
  const tags = version?.metadata?.container?.tags;
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => String(tag).toLowerCase() === `sha-${shortSha}`);
}

export interface GhcrLookupRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  backoffFactor?: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findPublishedGhcrVersionForHead(
  octokit: any,
  target: DeploymentTarget,
  headSha: string,
  retryOptions: GhcrLookupRetryOptions = {}
) {
  const parsed = parseGhcrPackageRef(target.package);
  if (!parsed) return null;

  const attempts = Math.max(1, retryOptions.attempts ?? 1);
  const baseDelayMs = Math.max(0, retryOptions.baseDelayMs ?? 0);
  const backoffFactor = Math.max(1, retryOptions.backoffFactor ?? 2);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { data } = await listGhcrPackageVersions(octokit, parsed.owner, parsed.packageName);

      const versions = Array.isArray(data) ? data : [];
      const version = versions.find((candidate) => packageVersionMatchesHeadSha(candidate, headSha));
      if (version) {
        return {
          packageName: parsed.packageName.split('/').pop() || parsed.packageName,
          packageUrl: parsed.packageUrl,
          version,
        };
      }
    } catch (error: any) {
      if (error?.status !== 404 || attempt === attempts) throw error;
    }

    if (attempt < attempts && baseDelayMs > 0) {
      await sleep(baseDelayMs * backoffFactor ** (attempt - 1));
    }
  }

  return null;
}

export function buildSyntheticGhcrVersionForHead(target: DeploymentTarget, headSha: string) {
  const parsed = parseGhcrPackageRef(target.package);
  if (!parsed) return null;

  const shortSha = headSha.slice(0, 7).toLowerCase();
  return {
    packageName: parsed.packageName.split('/').pop() || parsed.packageName,
    packageUrl: parsed.packageUrl,
    version: {
      id: `workflow-run-${shortSha}`,
      name: `sha-${shortSha}`,
      html_url: `https://github.com/orgs/${parsed.owner}/packages/container/${encodeURIComponent(parsed.packageName)}`,
      metadata: { container: { tags: [`sha-${shortSha}`] } },
    },
  };
}

export async function listGhcrPackageVersions(octokit: any, owner: string, packageName: string) {
  try {
    return await octokit.request('GET /orgs/{org}/packages/container/{package_name}/versions', {
      org: owner,
      package_name: packageName,
      per_page: 100,
    });
  } catch (error: any) {
    if (error?.status !== 404) throw error;

    return octokit.request('GET /users/{username}/packages/container/{package_name}/versions', {
      username: owner,
      package_name: packageName,
      per_page: 100,
    });
  }
}

export function buildRegistryPackagePayloadFromWorkflowRun(params: {
  workflowRun: any;
  repository: any;
  sender: any;
  packageName: string;
  packageUrl: string;
  packageVersion: any;
}) {
  const { workflowRun, repository, sender, packageName, packageUrl, packageVersion } = params;
  const headSha = workflowRun.head_sha;
  const ref = workflowRun.head_branch || repository.default_branch || 'main';

  return {
    action: 'published',
    repository,
    sender,
    registry_package: {
      name: packageName,
      package_type: 'CONTAINER',
      package_version: {
        id: packageVersion.id,
        version: packageVersion.name,
        html_url: packageVersion.html_url,
        package_url: packageUrl,
        target_oid: headSha,
        target_commitish: ref,
        metadata: packageVersion.metadata,
      },
    },
  };
}
