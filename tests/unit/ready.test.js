import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Replace the real dependency checks with fakes, to test how /ready and
// /health react to outages without actually stopping PostgreSQL, Redis or Kafka.
vi.mock('../../src/config/database.js', () => ({ isDatabaseHealthy: vi.fn() }));
vi.mock('../../src/config/redis.js', () => ({ isRedisHealthy: vi.fn(), isRedisReady: () => false }));
vi.mock('../../src/config/kafka.js', () => ({
  isProducerHealthy: vi.fn(),
  isProducerConnected: () => false,
  markSendFailed: vi.fn(),
  markSendSucceeded: vi.fn(),
  producer: {},
}));

const { isDatabaseHealthy } = await import('../../src/config/database.js');
const { isRedisHealthy } = await import('../../src/config/redis.js');
const { isProducerHealthy } = await import('../../src/config/kafka.js');
const { createApp } = await import('../../src/app.js');

const app = createApp();

function setHealth({ database, redis, kafka }) {
  vi.mocked(isDatabaseHealthy).mockResolvedValue(database);
  vi.mocked(isRedisHealthy).mockResolvedValue(redis);
  vi.mocked(isProducerHealthy).mockReturnValue(kafka);
}

describe('GET /ready', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns 200 "ready" when everything is up', async () => {
    setHealth({ database: true, redis: true, kafka: true });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up', kafka: 'up' } });
  });

  it('returns 503 "not_ready" when PostgreSQL (critical) is down', async () => {
    setHealth({ database: false, redis: true, kafka: true });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'down', redis: 'up', kafka: 'up' } });
  });

  it.each([
    ['Redis', { database: true, redis: false, kafka: true }],
    ['Kafka', { database: true, redis: true, kafka: false }],
  ])('returns 200 "degraded" when only %s (non-critical) is down', async (_, health) => {
    setHealth(health);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });
});

describe('GET /health', () => {
  it('returns 200 even when every dependency is down, because the process itself is fine', async () => {
    setHealth({ database: false, redis: false, kafka: false });
    expect((await request(app).get('/health')).status).toBe(200);
  });
});
