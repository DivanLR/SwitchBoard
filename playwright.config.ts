import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 5199)

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // The real-application harness launches Electron itself and needs no dev server.
  // It has its own config (playwright.real.config.ts) and `npm run test:real`;
  // running it here would start it without a build and with the wrong worker model.
  testIgnore: 'real-app.spec.ts',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:renderer',
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
