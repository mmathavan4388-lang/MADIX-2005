import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node', testTimeout: 30000, hookTimeout: 60000, fileParallelism: false,
    env: {
      NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://madix:madix@localhost:5432/madix_test',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-1234', DATA_ENCRYPTION_KEY: 'test-data-key-test-data-key-12345678',
      STORAGE_DRIVER: 'local', LOCAL_UPLOAD_DIR: '/tmp/madix-test-uploads', PUBLIC_API_URL: 'http://localhost:4000',
      RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'rzp_test_secret_value', RAZORPAY_WEBHOOK_SECRET: 'whsec_test_value',
    },
  },
});
