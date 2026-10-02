// Every call to the backend goes through request(). Requests use relative paths
// (/api/v1/...), so they go to the same origin as the page, and the browser
// sends the HTTP-only login cookie automatically. JavaScript never sees the token.
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(status, message, details = []) {
    super(message);
    this.status = status;
    this.details = details; // [{ field, message }] for validation errors
  }
}

// App.jsx sets this, so an expired login (401) sends the user back to the login page.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // A wrong password is also a 401, but that's not an expired session.
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
  }
  return data;
}

export const api = {
  me: () => request('GET', '/auth/me'),
  register: (email, password) => request('POST', '/auth/register', { email, password }),
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  logout: () => request('POST', '/auth/logout'),

  listUrls: (page, limit) => request('GET', `/urls?page=${page}&limit=${limit}`),
  createUrl: (link) => request('POST', '/urls', link),
  getUrl: (id) => request('GET', `/urls/${id}`),
  updateUrl: (id, changes) => request('PATCH', `/urls/${id}`, changes),
  deleteUrl: (id) => request('DELETE', `/urls/${id}`),
  getAnalytics: (id) => request('GET', `/urls/${id}/analytics`),
};
