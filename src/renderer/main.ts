import { createApp } from 'vue'
import App from './App.vue'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

async function boot(): Promise<void> {
  if (import.meta.env.DEV && !window.switchboard) {
    const { installMockHost, twoProjectScenario } = await import('../../tests/e2e/mock-host')
    installMockHost(twoProjectScenario())
  }
  createApp(App).mount('#app')
}

void boot()
