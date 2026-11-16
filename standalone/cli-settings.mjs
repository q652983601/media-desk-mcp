import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_DEFINITIONS, createAgentModelConfigs, findExecutable } from './agents.mjs'

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function validateProviders(providers) {
  const ids = Object.keys(AGENT_DEFINITIONS)
  if (!Array.isArray(providers) || providers.length !== ids.length || new Set(providers.map(row => row?.id)).size !== ids.length) {
    throw invalid('请提交全部四种 CLI 的配置。')
  }
  return ids.map(id => {
    const row = providers.find(value => value?.id === id)
    if (!row || typeof row.enabled !== 'boolean' || typeof row.command !== 'string' || !row.command.trim() || row.command.length > 1024 || /[\0\r\n]/.test(row.command)) {
      throw invalid(`${id} 的启用状态或可执行文件路径无效。`)
    }
    if (!Array.isArray(row.models) || !row.models.length || row.models.length > 30 || row.models.some(model => typeof model !== 'string' || model.length > 160 || !/^[\w./:@+-]+$/.test(model))) {
      throw invalid(`${id} 的模型列表无效，请用英文逗号分隔模型 ID。`)
    }
    return { id, enabled: row.enabled, command: row.command.trim(), models: [...new Set(row.models)] }
  })
}

/** One persisted configuration shared by UI and runtime. Changes require no restart. */
export async function createCliSettings({ dataDir, env, onChange }) {
  const file = join(dataDir, 'cli.json')
  const selected = new Set(String(env.MEDIA_DESK_AGENTS ?? '').split(',').map(value => value.trim()))
  for (const id of selected) if (id && !Object.hasOwn(AGENT_DEFINITIONS, id)) throw invalid(`Unsupported MEDIA_DESK_AGENTS entry: ${id}`)
  let saved = {
    revision: '0',
    providers: Object.entries(AGENT_DEFINITIONS).map(([id, definition]) => {
      const prefix = `MEDIA_DESK_${id.toUpperCase()}`
      return {
        id, enabled: selected.has(id), command: env[`${prefix}_COMMAND`] || definition.command || id,
        models: String(env[`${prefix}_MODELS`] || env[`${prefix}_MODEL`] || 'default').split(',').map(value => value.trim()).filter(Boolean),
      }
    }),
  }
  try { saved = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  saved.providers = validateProviders(saved.providers)
  if (typeof saved.revision !== 'string') throw invalid('CLI 配置缺少版本号。')
  let active = 0
  let updating = false
  let queue = Promise.resolve()

  function configurations(value = saved) {
    const configuredEnv = { ...env, MEDIA_DESK_AGENTS: value.providers.filter(row => row.enabled).map(row => row.id).join(',') }
    for (const row of value.providers) {
      configuredEnv[`MEDIA_DESK_${row.id.toUpperCase()}_COMMAND`] = row.command
      configuredEnv[`MEDIA_DESK_${row.id.toUpperCase()}_MODELS`] = row.models.join(',')
    }
    return createAgentModelConfigs(configuredEnv).map(config => ({
      ...config,
      async generate(input) {
        if (updating) throw Object.assign(new Error('CLI 配置正在保存，请稍后重试。'), { status: 409 })
        if (value.revision !== saved.revision) throw Object.assign(new Error('CLI 配置已更新，请重新发起生成。'), { status: 409 })
        active += 1
        try { return await config.generate(input) } finally { active -= 1 }
      },
    }))
  }

  function read(value = saved) {
    return {
      revision: value.revision,
      providers: value.providers.map(row => {
        const resolvedCommand = findExecutable(row.command, env)
        return { ...row, name: AGENT_DEFINITIONS[row.id].name, installed: Boolean(resolvedCommand), resolvedCommand, authenticated: 'unverified' }
      }),
    }
  }

  async function saveNow(body) {
    if (!body || typeof body !== 'object') throw invalid('CLI 配置必须为 JSON 对象。')
    if (body.expectedRevision !== saved.revision) throw Object.assign(new Error('CLI 配置已被更新，请重新读取后保存。'), { status: 409 })
    const providers = validateProviders(body.providers)
    if (active) throw Object.assign(new Error('CLI 正在生成内容，完成或取消后可保存配置。'), { status: 409 })
    updating = true
    const next = { revision: randomUUID(), providers }
    const temporary = `${file}.${process.pid}.tmp`
    try {
      const configs = configurations(next)
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
      await rename(temporary, file)
      saved = next
      onChange(configs)
      return read()
    } finally {
      updating = false
    }
  }

  return {
    read, configurations,
    detect(body) { return read({ revision: saved.revision, providers: validateProviders(body?.providers) }) },
    save(body) {
      const result = queue.then(() => saveNow(body))
      queue = result.catch(() => {})
      return result
    },
    async close() { await queue },
  }
}
