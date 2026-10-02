import request from 'supertest';

/** Register a user and return a Supertest agent that keeps their auth cookie (like a browser). */
export async function loggedInAgent(app, email = `user${Math.random().toString(36).slice(2, 10)}@example.com`) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/register').send({ email, password: 'test-password-123' });
  if (res.status !== 201) throw new Error(`Registration failed: ${res.status}`);
  agent.user = res.body.user;
  agent.cookie = res.headers['set-cookie'][0].split(';')[0]; // for parallel requests with request(app)
  return agent;
}
