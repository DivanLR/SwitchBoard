// Standalone Vite config for serving the renderer in a plain browser.
// Used by `npm run dev:renderer` and the Playwright web server; the packaged
// application is built with electron.vite.config.ts instead.
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
})
