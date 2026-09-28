// Prisma CLI configuration (used by `prisma migrate`, `prisma generate`, `prisma studio`).
// The application itself connects through src/config/database.js.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
