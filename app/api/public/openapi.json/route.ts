import { NextResponse } from 'next/server';
import { PUBLIC_API_INFO, PUBLIC_API_VERSION } from '@/lib/public-api';

export async function GET() {
  const spec = {
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
          responses: { '200': { description: 'Service is healthy' }, '401': { description: 'Unauthorized' } },
        },
      },
      [`/${PUBLIC_API_VERSION}/stats`]: {
        get: {
          summary: 'Get global Jean CI stats',
          responses: { '200': { description: 'Stats payload' }, '401': { description: 'Unauthorized' } },
        },
      },
      [`/${PUBLIC_API_VERSION}/repos`]: {
        get: {
          summary: 'List tracked repositories with last activity',
          responses: { '200': { description: 'Repository list' }, '401': { description: 'Unauthorized' } },
        },
      },
      [`/${PUBLIC_API_VERSION}/checks`]: {
        get: {
          summary: 'List check runs',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: { '200': { description: 'Paginated check runs' }, '401': { description: 'Unauthorized' } },
        },
      },
      [`/${PUBLIC_API_VERSION}/pipelines`]: {
        get: {
          summary: 'List deployment pipelines',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
          ],
          responses: { '200': { description: 'Paginated deployment pipelines' }, '401': { description: 'Unauthorized' } },
        },
      },
      [`/${PUBLIC_API_VERSION}/events`]: {
        get: {
          summary: 'List webhook events',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
            { name: 'eventType', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Paginated webhook events' }, '401': { description: 'Unauthorized' } },
        },
      },
      [`/${PUBLIC_API_VERSION}/tasks`]: {
        get: {
          summary: 'Get task summary or task events',
          parameters: [
            { name: 'view', in: 'query', schema: { type: 'string', enum: ['summary', 'events'] } },
            { name: 'repo', in: 'query', schema: { type: 'string' } },
            { name: 'task', in: 'query', schema: { type: 'string' } },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: { '200': { description: 'Task summary or events payload' }, '401': { description: 'Unauthorized' } },
        },
      },
    },
  };

  return NextResponse.json(spec);
}
