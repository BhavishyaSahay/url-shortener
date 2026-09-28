import request from 'supertest';

/**
 * Register a user and return a Supertest agent that keeps their auth cookie,
 * like a logged-in browser.
 */
export async function loggedInAgent(app, email = `user${Math.random().toString(36).slice(2, 10)}@example.com`) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/register').send({ email, password: 'test-password-123' });
  if (res.status !== 201) throw new Error(`Test registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  agent.user = res.body.user;
  // "access_token=…" for firing many simultaneous requests with request(app).set('Cookie', …).
  // (A single agent shares one HTTP server between its requests, which isn't meant for heavy concurrency.)
  agent.cookie = res.headers['set-cookie'].find((c) => c.startsWith('access_token=')).split(';')[0];
  return agent;
}
