import { defineConfig, env } from '@prisma/config';
import 'dotenv/config';

export default defineConfig({
  schema: './prisma/schema',

  migrations: {
    path: './prisma/migrations',
  },

  datasource: {
    url: env('DATABASE_URL'),
  },
});