const PUBLIC_API_VERSION = 'v1';
const PUBLIC_API_INFO = {
  title: 'Jean CI Public API',
  version: '1.0.0',
  description: 'Read-only access to Jean CI data without direct database access.',
} as const;

const pageParam = { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } } as const;
const checksLimitParam = { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } } as const;
const pipelinesLimitParam = { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } } as const;
const eventsLimitParam = { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } } as const;
const repoFilterParam = { name: 'repo', in: 'query', schema: { type: 'string' } } as const;
const ownerParam = { name: 'owner', in: 'path', required: true, schema: { type: 'string' } } as const;
const repoParam = { name: 'repo', in: 'path', required: true, schema: { type: 'string' } } as const;
const okResponse = { description: 'Success' } as const;
const badRequestResponse = { description: 'Bad request' } as const;
const unauthorizedResponse = { description: 'Unauthorized' } as const;

export function buildPublicOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: PUBLIC_API_INFO,
    servers: [{ url: '/api/public' }],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API Token',
        },
      },
    },
    paths: {
      [`/${PUBLIC_API_VERSION}/health`]: {
        get: {
          summary: 'Health check for authenticated public API clients',
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/local-review`]: {
        post: {
          summary: 'Run jean-ci review checks against a caller-provided local diff',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['repo', 'diff'],
                  properties: {
                    repo: { type: 'string', description: 'Repository slug, e.g. owner/repo' },
                    title: { type: 'string' },
                    body: { type: 'string' },
                    diff: { type: 'string', description: 'Unified git diff to review' },
                    headSha: { type: 'string', description: 'Commit SHA used to load git-backed .jean-ci/pr-checks prompts' },
                    ref: { type: 'string', description: 'Git ref used to load git-backed .jean-ci/pr-checks prompts when headSha is not provided' },
                    selectedChecks: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Optional subset of git-backed checks to run by name, including Code Review',
                    },
                  },
                },
              },
            },
          },
          responses: { '200': okResponse, '400': badRequestResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/stats`]: {
        get: {
          summary: 'Get global Jean CI stats',
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos`]: {
        get: {
          summary: 'List tracked repositories with last activity',
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/checks`]: {
        get: {
          summary: 'List check runs',
          parameters: [pageParam, checksLimitParam, repoFilterParam],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/pipelines`]: {
        get: {
          summary: 'List deployment pipelines',
          parameters: [pageParam, pipelinesLimitParam, repoFilterParam],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/events`]: {
        get: {
          summary: 'List webhook events',
          parameters: [pageParam, eventsLimitParam, { name: 'eventType', in: 'query', schema: { type: 'string' } }, repoFilterParam],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/tasks`]: {
        get: {
          summary: 'Get task summary or task events',
          parameters: [
            { name: 'view', in: 'query', schema: { type: 'string', enum: ['summary', 'events'] } },
            repoFilterParam,
            { name: 'task', in: 'query', schema: { type: 'string' } },
            pageParam,
            eventsLimitParam,
          ],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos/{owner}/{repo}`]: {
        get: {
          summary: 'Get details for a tracked repository',
          parameters: [ownerParam, repoParam],
          responses: { '200': okResponse, '401': unauthorizedResponse, '404': { description: 'Repository not found' } },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos/{owner}/{repo}/counts`]: {
        get: {
          summary: 'Get checks, deployments, and events counts for a repository',
          parameters: [ownerParam, repoParam],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos/{owner}/{repo}/checks`]: {
        get: {
          summary: 'List check runs for a repository',
          parameters: [ownerParam, repoParam, pageParam, checksLimitParam],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos/{owner}/{repo}/pipelines`]: {
        get: {
          summary: 'List deployment pipelines for a repository',
          parameters: [ownerParam, repoParam, pageParam, pipelinesLimitParam],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos/{owner}/{repo}/events`]: {
        get: {
          summary: 'List webhook events for a repository',
          parameters: [ownerParam, repoParam, pageParam, eventsLimitParam],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos/{owner}/{repo}/deployments`]: {
        get: {
          summary: 'List deployments for a repository',
          parameters: [ownerParam, repoParam, pageParam, eventsLimitParam],
          responses: { '200': okResponse, '401': unauthorizedResponse },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos/{owner}/{repo}/sessions`]: {
        get: {
          summary: 'List tracked feature sessions for a repository',
          parameters: [ownerParam, repoParam],
          responses: { '200': okResponse, '401': unauthorizedResponse, '404': { description: 'Repository not found' } },
        },
      },
    },
  } as const;
}
