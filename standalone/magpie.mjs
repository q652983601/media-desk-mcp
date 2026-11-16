import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function baseUrl(value) {
  let url
  try { url = new URL(value) } catch { throw bad('请输入有效的 Magpie 地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw bad('Magpie 地址应为 HTTP(S) 地址，凭据请填在网关密钥中。')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  return url.href.replace(/\/$/, '')
}

function modelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 250 && /^[\w./:@+\[\]-]+$/.test(value)
}

async function readCatalog(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response body')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2_000_000) {
        await reader.cancel()
        throw new Error('Model catalog exceeds size limit')
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } finally { reader.releaseLock() }
}

export function normalizeMagpieModels(rows) {
  if (!Array.isArray(rows) || rows.length > 1000) throw bad('Magpie 返回的模型列表格式无效。', 502)
  const models = new Map()
  for (const row of rows) {
    if (!row || !modelId(row.id)) continue
    if (Array.isArray(row.modalities?.output) && !row.modalities.output.includes('text')) continue
    const rawEfforts = row.reasoningEfforts ?? row.reasoning_levels ?? row.supported_reasoning_levels ?? row.reasoning?.efforts ?? []
    const efforts = Array.isArray(rawEfforts) ? rawEfforts.map(value => typeof value === 'string' ? value : value?.effort ?? value?.id ?? value?.reasoningEffort) : []
    models.set(row.id, {
      id: row.id,
      name: String(row.display_name || row.name || row.id).slice(0, 300),
      reasoningEfforts: [...new Set(efforts.filter(value => EFFORTS.includes(value)))],
    })
  }
  return [...models.values()]
}

/** The gateway owns accounts and routing. Media Desk stores one connection. */
export async function createMagpieSettings({ dataDir, env, onChange, fetchImpl = fetch, signal }) {
  const file = join(dataDir, 'magpie.json')
  let saved = {
    revision: '0', enabled: env.MEDIA_DESK_MAGPIE_ENABLED === '1',
    baseUrl: baseUrl(env.MEDIA_DESK_MAGPIE_URL || 'http://127.0.0.1:3425/v1'),
    apiKey: env.MEDIA_DESK_MAGPIE_TOKEN || env.MAGPIE_GATEWAY_KEY || '',
    model: env.MEDIA_DESK_MAGPIE_MODEL || '', models: [], reasoningEffort: '', fetchedAt: null,
  }
  try { saved = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  saved.baseUrl = baseUrl(saved.baseUrl)
  saved.models = normalizeMagpieModels(saved.models)
  if (typeof saved.revision !== 'string' || typeof saved.enabled !== 'boolean' || (saved.model && !modelId(saved.model)) || (saved.reasoningEffort && !EFFORTS.includes(saved.reasoningEffort))) throw bad('已保存的 Magpie 配置格式无效。')
  let queue = Promise.resolve()
  let updating = false
  let active = 0

  function read() {
    const { apiKey, ...publicConfig } = saved
    return { ...publicConfig, hasKey: Boolean(apiKey) }
  }

  function connection(body) {
    if (!body || typeof body !== 'object') throw bad('请提交 Magpie 配置。')
    const url = baseUrl(body.baseUrl)
    const sameOrigin = new URL(url).origin === new URL(saved.baseUrl).origin
    if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 8192 || /[\r\n]/.test(body.apiKey))) throw bad('网关密钥格式无效。')
    const key = body.clearKey ? '' : body.apiKey?.trim() || (sameOrigin ? saved.apiKey : '')
    return { baseUrl: url, apiKey: key }
  }

  async function discover(body) {
    const config = connection(body)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.baseUrl).hostname)
    const key = config.apiKey || (local ? 'magpie' : '')
    let response
    try {
      response = await fetchImpl(`${config.baseUrl}/models`, {
        headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10000), signal].filter(Boolean)),
      })
    } catch { throw bad('连接 Magpie 失败，请确认网关已启动并检查地址。', 502) }
    if (!response.ok) throw bad(`Magpie 模型查询返回 HTTP ${response.status}，请检查网关地址与密钥。`, 502)
    let value
    try { value = await readCatalog(response) } catch { throw bad('Magpie 模型列表无法解析、读取超时或超过大小限制。', 502) }
    const models = normalizeMagpieModels(value?.data)
    if (!models.length) throw bad('Magpie 尚未提供可选择的模型，请先在 Magpie 中配置提供方。', 502)
    return { models, fetchedAt: new Date().toISOString(), source: 'magpie' }
  }

  function configurations() {
    if (!saved.enabled || !saved.model) return []
    const revision = saved.revision
    const models = [...saved.models]
    if (!models.some(row => row.id === saved.model)) models.push({ id: saved.model, name: saved.model })
    models.sort((a, b) => Number(b.id === saved.model) - Number(a.id === saved.model))
    return models.map(row => ({
      provider: 'magpie', name: 'Magpie', model: row.id, label: row.name,
      baseUrl: saved.baseUrl, apiKey: saved.apiKey || 'magpie',
      reasoningEffort: row.id === saved.model ? saved.reasoningEffort : '',
      timeoutMs: Number(env.MEDIA_DESK_MODEL_TIMEOUT_MS) || 240000,
      acquire() {
        if (updating || revision !== saved.revision) throw bad('Magpie 配置已更新，请重新发起生成。', 409)
        active += 1
        return () => { active -= 1 }
      },
    }))
  }

  async function saveNow(body) {
    if (!body || body.expectedRevision !== saved.revision) throw bad('Magpie 配置已更新，请重新读取后保存。', 409)
    if (typeof body.enabled !== 'boolean' || (body.model && !modelId(body.model))) throw bad('Magpie 启用状态或模型 ID 无效。')
    if (body.enabled && !body.model) throw bad('请先选择 Magpie 模型。')
    if (body.reasoningEffort && !EFFORTS.includes(body.reasoningEffort)) throw bad('推理强度无效。')
    if (active) throw bad('Magpie 正在生成内容，完成或取消后可保存配置。', 409)
    const config = connection(body)
    const next = {
      revision: randomUUID(), enabled: body.enabled, ...config,
      model: body.model || '', models: normalizeMagpieModels(body.models ?? []),
      reasoningEffort: body.reasoningEffort || '', fetchedAt: typeof body.fetchedAt === 'string' ? body.fetchedAt.slice(0, 40) : null,
    }
    updating = true
    try {
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
      await rename(temporary, file)
      saved = next
      onChange()
      return read()
    } finally { updating = false }
  }

  return {
    read, discover, configurations,
    save(body) {
      const result = queue.then(() => saveNow(body))
      queue = result.catch(() => {})
      return result
    },
    async close() { await queue },
  }
}
