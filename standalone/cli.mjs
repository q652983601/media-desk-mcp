#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStandaloneServer } from './server.mjs'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Media Desk MCP — standalone content workspace

  npm start                  Start the original web interface and HTTP MCP
  npm run mcp                Start an MCP stdio proxy to the running service

Defaults: http://127.0.0.1:4319; MCP: http://127.0.0.1:4319/mcp
Configuration: copy .env.example to .env, or set MEDIA_DESK_* environment variables.
Codex and Kimi are optional. The service never installs a CLI or logs into an account.
See README.md for setup, authentication, and verified capability limits.`)
} else {
  if (args.length) throw new Error('Unknown command argument. Run media-desk --help.')
  const envPath = fileURLToPath(new URL('../.env', import.meta.url))
  if (existsSync(envPath)) process.loadEnvFile(envPath)
  const app = createStandaloneServer()
  try {
    const address = await app.listen()
    console.error(`Media Desk: ${address.url}\nMCP: ${address.mcpUrl}\nData: ${address.dataDir}`)
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      const timeout = setTimeout(() => process.exit(1), 10_000)
      timeout.unref()
      try { await app.close() } finally { clearTimeout(timeout) }
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  } catch (error) {
    console.error(`Media Desk could not start: ${error.message}`)
    await app.close()
    process.exitCode = 1
  }
}
