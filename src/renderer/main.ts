import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

/**
 * Dev-only browser bootstrap.
 *
 * Served through `npm run dev:renderer` there is no Electron preload, so
 * `window.switchboard` is undefined, the stores' first IPC calls throw, and the
 * whole app renders its empty states: no projects, no lanes, no stream. That
 * makes the sidebar's score margin invisible in a browser, which is exactly where
 * design iteration happens.
 *
 * So install the same mock host the end-to-end suite already drives
 * (tests/e2e/mock-host.ts) rather than inventing a second fixture that could
 * drift from it. Two projects, one playing and one held with a pending
 * permission, which is enough to show every notation mark and the now-line.
 *
 * Two guards keep this out of the real application:
 *   - `import.meta.env.DEV` is statically false in a production build, so the
 *     dynamic import below is dead code and never enters the bundle.
 *   - `!window.switchboard` means Electron always wins, dev or packaged, because
 *     the preload bridge is already there. This only fires in a bare browser.
 */
async function boot(): Promise<void> {
  if (import.meta.env.DEV && !window.switchboard) {
    const { installMockHost, twoProjectScenario } = await import('../../tests/e2e/mock-host')
    installMockHost(twoProjectScenario())
  }
  createApp(App).mount('#app')
}

void boot()
