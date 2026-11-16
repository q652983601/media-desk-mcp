// The outer HTTP server must perform its normal Host/Origin/token checks before
// delegating /mcp here. Requests remain stateless: all business state is in the
// single Media Desk service, not in per-client transports.
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { createMcpServer } from './mcp-tools.mjs'

export function createMcpHttpHandler(options = {}) {
  const active = new Set()
  return {
    async handle(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Only POST is supported by this stateless MCP endpoint' }, id: null }))
        return
      }
      const server = createMcpServer(options)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 30 * 1024 * 1024 })
      const entry = { server, transport }
      active.add(entry)
      let closed = false
      const close = async () => {
        if (closed) return
        closed = true
        active.delete(entry)
        await server.close().catch(() => {})
      }
      res.once('close', close)
      try {
        await server.connect(transport)
        await transport.handleRequest(req, res)
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP request failed' }, id: null }))
        } else if (!res.writableEnded) res.end()
        await close()
      }
    },
    async close() {
      await Promise.allSettled([...active].map(({ server }) => server.close()))
      active.clear()
    },
  }
}
