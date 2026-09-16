import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: Vite serves the client and proxies every /api/* call to the Express backend
// (server.js, default port 8787). `npm run dev` starts both together. This keeps dev and
// prod identical — the same server.js handles auth, history, usage, and the Claude proxy
// in both. Set API_PROXY_TARGET to point at a different backend port if you change it.
const API_TARGET = process.env.API_PROXY_TARGET || 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      // Karma Leads is served by Express from leads/public (no build step), so in
      // dev it has to be proxied like the API — Vite has nothing to serve for it.
      '/leads': { target: API_TARGET, changeOrigin: true },
    },
  },
})
