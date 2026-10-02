import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loggedInAgent } from '../helpers/auth.js';
import { resetState } from '../helpers/db.js';

const app = createApp();
beforeEach(resetState);

describe('rate limiting', () => {
  it('allows 10 login attempts per 15 minutes, then returns 429 with Retry-After', async () => {
    const attempt = () => request(app).post('/api/v1/auth/login').send({ email: 'x@example.com', password: 'guess' });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('allows 30 new URLs per minute per user, counted separately for each user', async () => {
    const [alice, bob] = await Promise.all([loggedInAgent(app), loggedInAgent(app)]);
    const create = (agent, i) => request(app).post('/api/v1/urls').set('Cookie', agent.cookie).send({ url: `https://e.com/${i}` });

    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => create(alice, i)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await create(alice, 31)).status).toBe(429);
    expect((await create(bob, 1)).status).toBe(201);
  });
});
