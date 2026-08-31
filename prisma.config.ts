import { defineConfig, env } from '@prisma/config';
import 'dotenv/config';

export default defineConfig({
  schema: './prisma/schema',

  datasource: {
    url: env('DATABASE_URL'),
  },
});