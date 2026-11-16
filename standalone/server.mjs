import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeskRuntime } from '../src/host.js'
import { createModelServices, modelConfigFromEnv } from './model.mjs'
import { acquireDataLock, createRequestPolicy, defaultDataDir, equalToken, isLoopback } from './runtime.mjs'
import { attachProductionAsset, importProduction, productionRevision } from './production-import.mjs'
import { createMcpHttpHandler } from './mcp-http.mjs'
import { createCliSettings } from './cli-settings.mjs'
import { setAssistantModel } from '../src/ai.js'
import { createMagpieSettings } from './magpie.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function readBody(req, limit = 4_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('Request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req) {
  try { return JSON.parse(await readBody(req)) } catch (error) {
    if (error.status) throw error
    throw Object.assign(new Error('Invalid JSON request'), { status: 400 })
  }
}

const LOGIN = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自媒体工作台</title><style>body{font-family:system-ui,sans-serif;background:#f7f6f2;color:#262722;margin:0;display:grid;place-items:center;min-height:100vh}main{width:min(360px,80vw)}h1{font-weight:500}input,button{box-sizing:border-box;width:100%;padding:14px;margin:10px 0;border:1px solid #d2d4c9;border-radius:10px;font:inherit}button{background:#273c35;color:white;cursor:pointer}p{line-height:1.8;color:#646b61}</style><main><h1>自媒体工作台</h1><p>输入此工作台的访问密钥，继续使用。</p><form method="post" action="/session"><input type="password" name="token" autocomplete="current-password" placeholder="访问密钥" required><button type="submit">进入工作台</button></form></main></html>`

/** No DSH installation is needed. All MCP and UI writes use this one runtime. */
export function createStandaloneServer(options = {}) {
  const env = options.env ?? process.env
  const host = options.host ?? env.MEDIA_DESK_HOST ?? '127.0.0.1'
  const port = Number(options.port ?? env.MEDIA_DESK_PORT ?? 4319)
  const token = options.token ?? env.MEDIA_DESK_TOKEN ?? ''
  const allowedHosts = options.allowedHosts ?? (env.MEDIA_DESK_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const allowMonid = options.allowMonid ?? env.MEDIA_DESK_ENABLE_MONID === '1'
  const webRoot = options.webRoot ?? join(ROOT, 'dist', 'standalone')
  let currentPort = port
  let lock, runtime, mcp, address, startPromise, closePromise
  let cliSettings, magpieSettings, services, baseConfigs
  let closing = false
  const shutdown = new AbortController()
  const policy = createRequestPolicy({ host, token, allowedHosts, getPort: () => currentPort })
  const pending = new Set()

  const server = createServer((req, res) => {
    const request = handle(req, res).catch(error => {
      if (res.headersSent) { res.end(); return }
      json(res, error.status || 500, { error: error.message })
    })
    pending.add(request)
    request.finally(() => pending.delete(request))
  })
  server.requestTimeout = 300_000
  server.headersTimeout = 30_000

  async function handle(req, res) {
    const rejection = policy.hostOriginRejection(req.headers)
    if (rejection) return json(res, rejection, { error: 'Host or Origin is not allowed' })
    const path = new URL(req.url || '/', 'http://local').pathname
    if (path === '/healthz' && req.method === 'GET') return json(res, 200, { ok: Boolean(runtime && !closing), service: 'morandi-media-desk', standalone: true })
    if (path === '/session' && req.method === 'POST') {
      const input = new URLSearchParams(await readBody(req, 8_192))
      if (!token || !equalToken(input.get('token'), token)) return json(res, 401, { error: '访问密钥不正确' })
      const secure = req.socket.encrypted || req.headers.origin?.startsWith('https://') ? '; Secure' : ''
      res.writeHead(303, { location: '/', 'set-cookie': `media_desk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end()
      return
    }
    if (!policy.authorized(req.headers)) {
      if ((path === '/' || path === '/session') && req.method === 'GET') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end(LOGIN)
        return
      }
      return json(res, 401, { error: 'Unauthorized' })
    }
    if (closing) return json(res, 503, { error: 'Server is stopping' })
    if (path === '/mcp') return mcp ? mcp.handle(req, res) : json(res, 503, { error: 'MCP is starting' })
    if (path === '/media-desk' || path.startsWith('/media-desk/')) return runtime.handler(req, res)
    if ((req.method === 'GET' || req.method === 'HEAD') && ['/', '/index.html', '/app.js', '/app.js.map'].includes(path)) {
      let data
      try { data = await readFile(join(webRoot, path === '/' ? 'index.html' : path.slice(1))) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return json(res, 503, { error: 'Frontend is not built. Run npm run build:standalone.' })
      }
      res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.map') ? 'application/json' : 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' })
      res.end(req.method === 'HEAD' ? undefined : data)
      return
    }
    return json(res, 404, { error: 'Not found' })
  }

  async function beforeRoute({ req, res, store, producer }) {
    const url = new URL(req.url || '/', 'http://local')
    const path = url.pathname
    if (path === '/media-desk/magpie/models' && req.method === 'POST') {
      json(res, 200, await magpieSettings.discover(await readJson(req)))
      return true
    }
    if (path === '/media-desk/magpie' && ['GET', 'POST'].includes(req.method)) {
      const result = req.method === 'POST' ? await magpieSettings.save(await readJson(req)) : magpieSettings.read()
      if (req.method === 'POST') {
        if (result.enabled) {
          const updated = await runtime.settings.update({ assistant: { provider: 'magpie', model: result.model } })
          setAssistantModel(updated.assistant)
        } else await reconcileAssistant()
      }
      json(res, 200, result)
      return true
    }
    if (path === '/media-desk/cli/detect' && req.method === 'POST') {
      json(res, 200, cliSettings.detect(await readJson(req)))
      return true
    }
    if (path === '/media-desk/cli' && ['GET', 'POST'].includes(req.method)) {
      const result = req.method === 'POST' ? await cliSettings.save(await readJson(req)) : cliSettings.read()
      if (req.method === 'POST') {
        if (result.assistant) {
          const updated = await runtime.settings.update({ assistant: result.assistant })
          setAssistantModel(updated.assistant)
        } else await reconcileAssistant()
      }
      json(res, 200, { ...result, assistant: (await runtime.settings.read()).assistant })
      return true
    }
    if (req.method === 'GET' && path === '/media-desk/production') {
      const id = url.searchParams.get('id') || ''
      await producer.settle(id)
      const item = (await store.read()).items.find(value => value.id === id)
      json(res, 200, { production: item?.production ?? null, status: item?.status, live: producer.status(id), revision: productionRevision(item?.production) })
      return true
    }
    if (req.method === 'POST' && path === '/media-desk/production/import') {
      json(res, 200, await importProduction({ store, producer, body: await readJson(req) }))
      return true
    }
    if (req.method === 'POST' && path === '/media-desk/production/attach') {
      json(res, 200, await attachProductionAsset({ store, producer, body: await readJson(req) }))
      return true
    }
    if (path === '/media-desk/monid/import' && !allowMonid) {
      json(res, 403, { error: '账号数据导入需要明确启用 Monid，可能产生费用；在部署配置中设置 MEDIA_DESK_ENABLE_MONID=1 后使用。' })
      return true
    }
    if (path === '/media-desk/monid/status' && !allowMonid) {
      json(res, 200, { state: 'missing', disabled: true })
      return true
    }
    if (req.method === 'POST' && path === '/media-desk/produce/reveal' && !isLoopback(host)) {
      const body = await readJson(req)
      const path = (await store.read()).items.find(value => value.id === body.id)?.production?.savedPath
      json(res, path ? 200 : 400, path ? { path, revealed: false, notice: '文件已保存到工作台服务器。' } : { error: '还没有保存过' })
      return true
    }
    return false
  }

  async function start() {
    lock = await acquireDataLock(options.dataDir ?? defaultDataDir(env))
    try {
      const supplied = options.modelConfig === undefined ? modelConfigFromEnv(env) : options.modelConfig
      baseConfigs = (Array.isArray(supplied) ? supplied : [supplied]).filter(Boolean)
      const refreshServices = () => {
        const configs = [...(magpieSettings?.configurations() ?? []), ...baseConfigs, ...(cliSettings?.configurations() ?? [])]
        services = createModelServices(configs, { fetchImpl: options.fetchImpl, signal: shutdown.signal })
      }
      cliSettings = await createCliSettings({ dataDir: lock.dataDir, env, onChange: refreshServices })
      magpieSettings = await createMagpieSettings({ dataDir: lock.dataDir, env, onChange: refreshServices, fetchImpl: options.fetchImpl, signal: shutdown.signal })
      refreshServices()
      const ctx = { get: name => name === 'connection' ? policy : services[name] }
      runtime = createDeskRuntime(ctx, {
        root: lock.dataDir,
        skillHome: lock.dataDir,
        versionCheck: { read: async () => ({ ready: true, current: '0.1.0', latest: null, updateAvailable: false, failed: false, checkedAt: null, channel: 'standalone', upstreamVersion: '2.7.2' }) },
        beforeRoute,
      })
      await runtime.ready
      await reconcileAssistant()
      await runtime.store.read()
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { server.off('error', reject); resolve() })
      })
      currentPort = server.address().port
      const boundAddress = server.address().address
      const connectHost = ['::', '::1'].includes(boundAddress) ? '[::1]' : boundAddress === '0.0.0.0' || host === 'localhost' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host
      const baseUrl = `http://${connectHost}:${currentPort}`
      mcp = createMcpHttpHandler({ baseUrl, token, publicUrl: options.publicUrl ?? env.MEDIA_DESK_PUBLIC_URL })
      address = { host, port: currentPort, url: baseUrl, mcpUrl: `${baseUrl}/mcp`, dataDir: lock.dataDir }
      return address
    } catch (error) {
      if (server.listening) await new Promise(resolve => server.close(resolve))
      await lock.release()
      throw error
    }
  }

  async function reconcileAssistant() {
    const saved = await runtime.settings.read()
    if (!saved.assistant.provider) return
    const models = await services.llm?.listModels(saved.assistant.provider) ?? []
    if (models.some(model => model.id === saved.assistant.model)) return
    const updated = await runtime.settings.update({ assistant: { provider: '', model: '' } })
    setAssistantModel(updated.assistant)
  }

  return {
    listen() { return startPromise ??= start() },
    close() {
      return closePromise ??= (async () => {
        if (!startPromise) return
        await startPromise.catch(() => {})
        closing = true
        shutdown.abort()
        const jobs = [...(runtime?.producer.jobs.values() ?? []), ...(runtime?.producer.assetJobs.values() ?? [])]
        for (const job of jobs) job.controller.abort()
        await mcp?.close()
        if (server.listening) {
          const closed = new Promise(resolve => server.close(resolve))
          server.closeIdleConnections?.()
          server.closeAllConnections?.()
          await closed
        }
        await Promise.allSettled([...pending, ...jobs.map(job => job.promise).filter(Boolean)])
        await runtime?.store.queue
        await runtime?.settings.queue
        await cliSettings?.close()
        await magpieSettings?.close()
        await lock?.release()
      })()
    },
    get runtime() { return runtime },
    get address() { return address },
  }
}
