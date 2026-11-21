import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @agent-team/db db:generate --name <change>` writes a timestamped SQL migration
// into drizzle/; it is applied automatically when a store is opened (src/migrate.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/schema/entities.ts', './src/schema/records.ts'],
  out: './drizzle',
  migrations: { prefix: 'timestamp' },
  strict: true,
  verbose: false,
});
