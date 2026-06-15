import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ODDS_API_KEY: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  ODDS_API_KEY_2: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  ODDS_API_KEY_3: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  API_FOOTBALL_KEY: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌  Invalid environment variables:\n', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
