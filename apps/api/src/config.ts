import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  DATABASE_URL: z.string().default('postgres://madix:madix@localhost:5432/madix'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
  DATA_ENCRYPTION_KEY: z.string().min(32, 'DATA_ENCRYPTION_KEY must be >= 32 chars'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  ADMIN_SESSION_TTL_MIN: z.coerce.number().default(60),
  TRUST_PROXY: bool.default('false'),

  // Storage: "s3" (S3/R2/GCS-interop/MinIO) or "local" (dev only)
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  LOCAL_UPLOAD_DIR: z.string().default('./uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default('false'),
  CDN_BASE_URL: z.string().optional(), // e.g. https://cdn.madix.app — public files are served from here

  // Payments (Razorpay: UPI, GPay, cards, netbanking, wallets)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Email
  SMTP_URL: z.string().optional(), // smtp://user:pass@host:587
  MAIL_FROM: z.string().default('MADIX <no-reply@madix.app>'),

  // Push (FCM HTTP v1 via service-account is configured in deploy; token-based sender below)
  FCM_SERVER_KEY: z.string().optional(),

  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().default(4),
  MAX_UPLOAD_MB: z.coerce.number().default(200),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n' + parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
if (isProd && config.STORAGE_DRIVER === 'local') {
  console.warn('WARNING: STORAGE_DRIVER=local in production is not scalable. Use s3.');
}

// Fail fast on unsafe production configuration.
if (isProd) {
  const problems: string[] = [];
  for (const k of ['JWT_SECRET', 'DATA_ENCRYPTION_KEY'] as const) if (/change-me|dev-|test-/.test(config[k])) problems.push(`${k} looks like a placeholder`);
  if (config.PUBLIC_WEB_URL.startsWith('http://')) problems.push('PUBLIC_WEB_URL must be https');
  if (config.STORAGE_DRIVER === 's3' && !config.S3_BUCKET) problems.push('S3_BUCKET is required');
  if (!config.SMTP_URL) problems.push('SMTP_URL is required (verification and reset emails)');
  if (problems.length) { console.error('Refusing to start in production:\n - ' + problems.join('\n - ')); process.exit(1); }
}
