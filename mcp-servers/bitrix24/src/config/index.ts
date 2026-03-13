import { z } from 'zod';

const ConfigSchema = z.object({
  BITRIX24_WEBHOOK_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});

export const config = ConfigSchema.parse(process.env);
