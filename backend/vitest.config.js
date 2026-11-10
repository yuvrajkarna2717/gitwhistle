import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.js'],
    setupFiles: ['./test/setupEnv.js'],
    include: ['test/**/*.test.js'],
    // Tests share one database and truncate between cases.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
