import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app is served under /app/ so its pages (/app/login, /app/links/1) never
// clash with short links, which use every other path (/w7e, /my-alias).
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    // In development, forward API calls to the backend (Docker on port 8080).
    // The browser only ever talks to one origin, so the login cookie just works
    // and no CORS setup is needed. In production nginx does the same job.
    proxy: {
      '/api': process.env.API_URL ?? 'http://localhost:8080',
    },
  },
});
