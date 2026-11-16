#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createMcpServer } from './mcp-tools.mjs'

export async function startStdio(options = {}) {
  const server = createMcpServer(options)
  // 20 MiB image bytes expand to roughly 27 MiB when a client uses base64.
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 30 * 1024 * 1024 }))
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdio().catch(error => {
    console.error(`Media Desk MCP failed: ${error.message}`)
    process.exitCode = 1
  })
}
