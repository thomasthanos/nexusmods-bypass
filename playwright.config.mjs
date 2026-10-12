import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/visual',
  timeout: 90000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/playwright'
});
