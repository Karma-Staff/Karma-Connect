import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import proxyCore from './api/_proxy.cjs'

// Local-dev version of /api/claude. Uses the SAME shared core as the Vercel function
// (api/claude.js) so they can't drift. Auth is skipped on localhost (requireAuth: false);
// rate-limit / usage / cache stay no-ops unless their env vars are set.
function devClaudeProxy(env) {
  return {
    name: 'dev-claude-proxy',
    configureServer(server) {
      // Make .env values available to the shared core (process.env) in dev.
      for (const [k, v] of Object.entries(env)) { if (process.env[k] === undefined) process.env[k] = v }
      server.middlewares.use('/api/claude', (req, res) => {
        let bodyString = ''
        req.on('data', (c) => { bodyString += c })
        req.on('end', async () => {
          try {
            const out = await proxyCore.handleClaude(
              { method: req.method, authHeader: req.headers.authorization || '', bodyString },
              { requireAuth: false },
            )
            res.statusCode = out.status
            for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v)
            res.end(out.body)
          } catch (e) {
            res.statusCode = 502
            res.end(JSON.stringify({ error: { message: 'Proxy error: ' + String(e) } }))
          }
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load ALL env vars (empty prefix) so server-only keys reach the shared core without
  // being exposed to the client bundle.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), devClaudeProxy(env)],
    server: { port: 3000, open: true },
  }
})
