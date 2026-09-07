import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('minimal backend foundation', () => {
  it('returns the approved health response and request ID', async () => {
    const app = await buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['x-request-id']).toMatch(/^request_/);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns the standard error envelope for an unknown route', async () => {
    const app = await buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/not-approved' });
    const body = response.json();

    expect(response.statusCode).toBe(404);
    expect(body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested route was not found.',
        requestId: response.headers['x-request-id'],
      },
    });
  });
});
