import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Local-dev version of the /api/claude proxy. Mirrors api/claude.js but skips the Supabase
// auth check (localhost only) so `npm run dev` works without Vercel/Supabase set up.
// Reads ANTHROPIC_API_KEY from .env at the SERVER level — it never reaches the browser.
function devClaudeProxy(env) {
  return {
    name: 'dev-claude-proxy',
    configureServer(server) {
      server.middlewares.use('/api/claude', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: { message: 'Method not allowed.' } })); return }
        const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
        if (!apiKey) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'Missing ANTHROPIC_API_KEY in .env (server-side, no VITE_ prefix). Add it and restart.' } })); return }
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', async () => {
          try {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
              body,
            })
            const text = await r.text()
            res.statusCode = r.status
            res.setHeader('Content-Type', 'application/json')
            res.end(text)
          } catch (e) {
            res.statusCode = 502
            res.end(JSON.stringify({ error: { message: 'Upstream request failed: ' + String(e) } }))
          }
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load ALL env vars (empty prefix), so the server-only ANTHROPIC_API_KEY is available
  // here in Node without being exposed to the client bundle.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), devClaudeProxy(env)],
    server: { port: 3000, open: true },
  }
})
