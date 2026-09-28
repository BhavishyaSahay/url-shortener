import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Replace the real database module with a fake one whose health check fails,
// to test how /ready and /health behave during a database outage without
// actually stopping PostgreSQL.
vi.mock('../../src/config/database.js', () => ({
  isDatabaseHealthy: vi.fn().mockResolvedValue(false),
}));

const { createApp } = await import('../../src/app.js');

describe('when the database is down', () => {
  const app = createApp();

  it('GET /ready returns 503 and reports which dependency failed', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'down' } });
  });

  it('GET /health still returns 200, because the process itself is fine', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
