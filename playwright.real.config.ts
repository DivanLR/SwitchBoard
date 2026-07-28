// Real-application config: launches the built Electron app itself, so there is no
// dev server and no mock host. Kept separate from playwright.config.ts because
// that one starts the renderer dev server for every run, which this must not use.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'real-app.spec.ts',
  // One Electron instance, shared and stateful: the tests build on each other.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
