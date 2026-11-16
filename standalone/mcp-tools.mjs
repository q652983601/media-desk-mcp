// The MCP layer is a client of the one persistent HTTP service. It never opens
// state.json: every UI and agent write reaches the same Store/Producer queue.
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { productionInput, productionRevision } from './production-import.mjs'
import { readUploadAsset, MAX_ASSET_BYTES } from './mcp-assets.mjs'

const id = z.string().min(1).max(160)
const text = (max = 40000) => z.string().max(max)
const statuses = z.enum(['idea', 'outline', 'draft', 'ready', 'published'])
const platforms = z.enum(['公众号', '小红书', '抖音', 'B站', '视频号', 'TikTok', 'Instagram', 'YouTube', 'X'])
const kinds = z.enum(['image', 'video', 'web', 'quote', 'note'])
const when = z.string().datetime({ offset: true })
const mediaPath = z.string().max(2000).regex(/^media-desk\/(?:assets|files)\/[\w.-]+\.(?:png|jpe?g|gif|webp)$/i)

const styleFields = {
  name: text(100).optional(), summary: text(4000).optional(), tone: text(4000).optional(),
  sentences: text(4000).optional(), opening: text(4000).optional(), structure: text(4000).optional(),
  logic: text(4000).optional(), story: text(4000).optional(), flow: text(4000).optional(),
  words: z.array(text(1000)).max(24).optional(), avoid: z.array(text(1000)).max(24).optional(),
  samples: z.array(text(10000)).max(24).optional(),
}

function cleanObject(value) {
  if (Array.isArray(value)) return value.map(cleanObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:apiKey|api_key|token|password|authorization|cookie|secret)$/i.test(key))
    .map(([key, val]) => [key, cleanObject(val)]))
}

function summary(item) {
  return {
    id: item.id, title: item.title, kind: item.kind, status: item.status,
    platform: item.platform ?? null, scheduledAt: item.scheduledAt ?? null,
    tags: item.tags ?? [], sample: Boolean(item.sample), createdAt: item.createdAt,
    productionStatus: item.production?.status ?? null,
  }
}

function originUrl(value, name) {
  const base = new URL(value)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`)
  }
  return base
}

export function createDeskClient({ baseUrl = process.env.MEDIA_DESK_URL || 'http://127.0.0.1:4319', publicUrl = process.env.MEDIA_DESK_PUBLIC_URL || baseUrl, token = process.env.MEDIA_DESK_TOKEN || '', fetchImpl = fetch } = {}) {
  const base = originUrl(baseUrl, 'MEDIA_DESK_URL')
  const ui = originUrl(publicUrl, 'MEDIA_DESK_PUBLIC_URL')
  // A local stdio client may reach a service on the same machine without TLS.
  // A remote bearer token must not be sent over an unencrypted connection.
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  if (token && base.protocol === 'http:' && !loopback && process.env.MEDIA_DESK_ALLOW_INSECURE_REMOTE !== 'true') {
    throw new Error('Remote bearer tokens require HTTPS; use a trusted TLS proxy or an explicit private-network override')
  }
  const baseOrigin = base.origin
  const redact = value => token ? String(value).split(token).join('[REDACTED]') : String(value)
  const request = async (path, body, mimeType) => {
    // All callers use a fixed route below. No tool can provide arbitrary paths.
    let res
    try {
      res = await fetchImpl(new URL(`/media-desk/${path}`, baseOrigin), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json', 'x-media-desk-lang': 'zh',
          ...(body === undefined ? {} : { 'content-type': mimeType || 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: mimeType ? body : JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      })
    } catch (error) {
      throw new Error(`Media Desk service is unavailable at ${baseOrigin}: ${redact(error.message)}`)
    }
    let data
    try { data = await res.json() } catch { throw new Error(`Media Desk returned non-JSON (HTTP ${res.status})`) }
    if (!res.ok) throw new Error(redact(data?.error || `Media Desk HTTP ${res.status}`))
    if (Array.isArray(data?.errors) && data.errors.length) throw new Error(redact(data.errors.join('; ')))
    return cleanObject(data)
  }
  const state = async () => (await request('state')).state
  const ops = async (label, op) => {
    const result = await request('ops', { label, ops: [op] })
    const receipt = result.receipts?.[0]
    const item = receipt?.target ? result.state?.items?.find(row => row.id === receipt.target) : undefined
    return { receipts: result.receipts ?? [], ...(item ? { item } : {}) }
  }
  const upload = async ({ bytes, mimeType }) => request('upload', bytes, mimeType)
  return { baseUrl: baseOrigin, publicUrl: ui.origin, request, state, ops, upload }
}

export function createMcpServer(options = {}) {
  const api = createDeskClient(options)
  const server = new McpServer({ name: 'morandi-media-desk', version: '0.1.0' }, {
    instructions: 'Media Desk shares one persistent workspace with its original web UI. Read existing items before writing. For AI-authored articles/scripts, use write_production: it stores your work without invoking another model. Generation tools may invoke explicitly configured providers; obtain the user’s cost approval before starting paid work. Scheduling records a plan only; it does not publish to social platforms. Export paths belong to the server machine. This MCP does not claim universal in-chat UI support; open returns the standalone web URL.',
    maxToolInputElements: 20000,
  })

  const tool = (name, description, inputSchema, handler, { readOnly = false, destructive = false, openWorld = false, idempotent = false } = {}) => {
    server.registerTool(`media_desk_${name}`, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: openWorld, idempotentHint: readOnly || idempotent },
    }, async args => {
      try {
        const data = cleanObject(await handler(args))
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] }
      }
    })
  }

  tool('open', 'Return the URL of the original Media Desk frontend and service availability. Open this web URL to use the full UI.', z.object({}).strict(), async () => {
    const data = await api.request('state')
    return { url: `${api.publicUrl}/`, available: true, itemCount: data.state.items.length, model: data.model, modelOk: data.modelOk }
  }, { readOnly: true })

  tool('list_items', 'Search saved ideas and content. Returns bounded summaries; use get_item for full content. Sample items are explicitly marked.', z.object({
    query: text(1000).optional(), status: statuses.optional(), platform: platforms.optional(),
    includeSamples: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).default(0),
  }).strict(), async ({ query, status, platform, includeSamples, limit, offset }) => {
    const state = await api.state()
    const q = query?.trim().toLocaleLowerCase()
    const items = state.items.filter(item => (!status || item.status === status) && (!platform || item.platform === platform)
      && (includeSamples || !item.sample) && (!q || [item.title, item.body, ...(item.tags ?? [])].join('\n').toLocaleLowerCase().includes(q)))
    return { total: items.length, items: items.slice(offset, offset + limit).map(summary), nextOffset: offset + limit < items.length ? offset + limit : null }
  }, { readOnly: true })

  tool('get_item', 'Read one idea including the full article, storyboard, assets, and production status, plus the selected writing style and active rules.', z.object({ id }).strict(), async ({ id }) => {
    const state = await api.state()
    const item = state.items.find(row => row.id === id)
    if (!item) throw new Error(`Item not found: ${id}`)
    return { item, productionRevision: productionRevision(item.production), activeStyle: state.styles?.find(row => row.id === state.activeStyleId) ?? null, rules: state.skills.filter(row => ['active', 'exported'].includes(row.status)), format: state.draftFormat }
  }, { readOnly: true })

  tool('save_idea', 'Create an idea, or update an existing idea by id. This writes user content only and does not call an AI provider or publish it.', z.object({
    id: id.optional(), title: text().optional(), body: text().optional(), kind: kinds.optional(),
    tags: z.array(text(200)).max(24).optional(), url: z.url().optional(), platform: platforms.optional(),
  }).strict(), async ({ id, ...fields }) => {
    if (!id && !fields.title?.trim() && !fields.body?.trim()) throw new Error('A new idea needs a title or body')
    if (fields.url && !/^https?:\/\//.test(fields.url)) throw new Error('Only HTTP(S) source URLs are supported')
    return api.ops(id ? 'MCP 更新灵感' : 'MCP 记录灵感', { op: id ? 'update_item' : 'add_item', ...(id ? { id } : {}), ...fields })
  })

  tool('schedule', 'Set or cancel a content publication plan. This only updates the calendar; it never publishes. Use an ISO timestamp with an explicit timezone offset.', z.object({
    id, scheduledAt: when.nullable(), platform: platforms.optional(),
  }).strict(), args => api.ops('MCP 排期', { op: 'schedule_item', ...args }), { idempotent: true })

  tool('set_status', 'Update the workflow status of an idea or content item. Setting published only records that publishing already happened; it does not send content to a platform.', z.object({ id, status: statuses }).strict(), args => api.ops('MCP 更新内容状态', { op: 'set_status', ...args }), { idempotent: true })

  tool('record_metrics', 'Append a real metric observation. Do not invent performance numbers. Repeating this call adds another observation, so do not blindly retry an uncertain result.', z.object({
    itemId: id.optional(), platform: platforms, date: when,
    views: z.number().int().min(0).optional(), likes: z.number().int().min(0).optional(),
    comments: z.number().int().min(0).optional(), shares: z.number().int().min(0).optional(), saves: z.number().int().min(0).optional(),
  }).strict(), args => api.ops('MCP 记录表现数据', { op: 'add_metric', ...args }))

  tool('style', 'List writing styles, save one (id updates, no id creates), or select a style by id. Selecting null clears the active style. No model call is performed.', z.object({
    action: z.enum(['list', 'save', 'select']), id: id.nullable().optional(), ...styleFields,
  }).strict(), async ({ action, id, ...fields }) => {
    if (action === 'list') {
      const state = await api.state()
      return { styles: state.styles ?? [], activeStyleId: state.activeStyleId ?? null }
    }
    if (action === 'select') {
      if (id === undefined) throw new Error('select requires id (or null to clear)')
      return api.ops('MCP 选择写作风格', { op: 'set_style', id })
    }
    if (!id && !fields.name?.trim()) throw new Error('A new style needs a name')
    const result = await api.ops('MCP 保存写作风格', { op: id ? 'update_style' : 'add_style', ...(id ? { id } : {}), ...fields })
    return { ...result, styles: (await api.state()).styles }
  })

  tool('rules', 'List or save writing rules, derive proposed rules from saved metrics, or export active rules as a portable Skill in the service data directory. This does not install the Skill into an agent.', z.object({
    action: z.enum(['list', 'save', 'learn', 'export']), id: id.optional(), name: text(1000).optional(), rule: text().optional(),
    source: text(2000).optional(), evidence: text(4000).optional(), status: z.enum(['proposed', 'active', 'exported']).optional(),
  }).strict(), async ({ action, id, ...fields }) => {
    if (action === 'list') return { rules: (await api.state()).skills }
    if (action === 'learn') {
      const result = await api.request('skills/learn', {})
      return { added: result.added, rules: result.state.skills }
    }
    if (action === 'export') {
      const { state, ...result } = await api.request('skills/export', {})
      return { ...result, pathLocation: 'server', rules: state?.skills }
    }
    if (!id && (!fields.name?.trim() || !fields.rule?.trim())) throw new Error('A new rule needs name and rule')
    const result = await api.ops('MCP 保存写作规则', { op: id ? 'update_skill' : 'add_skill', ...(id ? { id } : {}), ...fields })
    return { ...result, rules: (await api.state()).skills }
  })

  tool('generation_start', 'Start the configured server-side generation pipeline and return promptly. May consume configured model/image credits; confirm cost authorization first. Prefer write_production when the calling agent has already written the content. Images default off.', z.object({
    id, withImages: z.boolean().default(false), costApproved: z.literal(true),
  }).strict(), async ({ id, withImages }) => {
    const result = await api.request('produce', { id, withImages })
    return { id, started: result.started, production: result.state.items.find(row => row.id === id)?.production ?? null }
  }, { openWorld: true })

  tool('generation_status', 'Read the current generation progress and saved production. Does not start or retry generation.', z.object({ id }).strict(), async ({ id }) => {
    const result = await api.request(`production?id=${encodeURIComponent(id)}`)
    return { ...result, revision: productionRevision(result.production) }
  }, { readOnly: true })

  tool('generation_cancel', 'Request cancellation of the running generation for one item. Already saved content remains available.', z.object({ id }).strict(), args => api.request('produce/cancel', args), { idempotent: true })

  tool('write_production', 'Store a complete AI-authored article/script, title, cover plan, illustrations and storyboard in the original frontend, without calling another model. Source paths must name existing Media Desk assets. Supply expectedRevision from the last item read (null for no prior imported production) to prevent stale edits; omit only for a deliberate overwrite.', z.object({
    id, production: productionInput, expectedRevision: z.string().max(200).nullable().optional(),
    author: text(200).default('external-agent'),
  }).strict(), args => api.request('production/import', args))

  tool('upload_asset', 'Upload an externally generated PNG/JPEG/GIF/WebP (up to 20 MiB) into this workspace. Provide base64 bytes, or filePath on the MCP process machine under explicitly configured MEDIA_DESK_IMPORT_ROOTS. Returns a media-desk/files path for attach_asset. No remote URLs are fetched and no image model is invoked.', z.object({
    filePath: z.string().min(1).max(4096).optional(),
    base64: z.string().min(1).max(Math.ceil(MAX_ASSET_BYTES / 3) * 4).optional(),
  }).strict(), async args => {
    const asset = await readUploadAsset(args, { importRoots: options.importRoots })
    const uploaded = await api.upload(asset)
    return { ...uploaded, bytes: asset.bytes.length, mimeType: asset.mimeType, url: `${api.publicUrl}/${uploaded.src}` }
  })

  tool('attach_asset', 'Attach an existing workspace image to the cover, an illustration, or a storyboard frame. Indexes start at zero. Use upload_asset first for a newly generated external image; this action does not generate an image.', z.object({
    id, target: z.string().regex(/^(?:cover|image:[0-7]|shot:(?:[0-9]|1[0-9]|2[0-3]))$/), src: mediaPath,
    expectedRevision: z.string().max(200).nullable().optional(),
  }).strict(), args => api.request('production/attach', args))

  tool('export_production', 'Save an existing production and its media to a folder on the service machine. This is a local export, not social publishing or a client-side download.', z.object({ id }).strict(), async args => {
    const { state, ...result } = await api.request('produce/save', args)
    return { ...result, pathLocation: 'server', itemId: args.id }
  })

  tool('insights', 'Read computed insights from the stored observations. The returned sample flags distinguish demo content from user evidence.', z.object({}).strict(), () => api.request('insights'), { readOnly: true })

  const resource = (name, uri, description, read) => server.registerResource(name, uri, {
    description, mimeType: 'application/json',
  }, async () => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(cleanObject(await read())) }] }))
  resource('board', 'media-desk://board', 'Content board with bounded summaries and aggregate counts.', async () => {
    const state = await api.state()
    return { url: `${api.publicUrl}/`, total: state.items.length, items: state.items.slice(0, 100).map(summary) }
  })
  resource('writing-context', 'media-desk://writing-context', 'Selected writing style, writing format, and active rules; no provider credentials.', async () => {
    const state = await api.state()
    return { style: state.styles?.find(row => row.id === state.activeStyleId) ?? null, format: state.draftFormat,
      rules: state.skills.filter(row => ['active', 'exported'].includes(row.status)) }
  })
  resource('insights', 'media-desk://insights', 'Current performance insights.', () => api.request('insights'))
  return server
}
