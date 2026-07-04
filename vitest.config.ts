import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    // Never run against generated apps (they're separate, independent
    // Next.js projects with their own code, not part of this test suite)
    // or the CDK output/build artifacts.
    exclude: ['**/node_modules/**', '**/generated-projects/**', '**/.next/**', '**/infra/cdk.out/**'],
  },
});
