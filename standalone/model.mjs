/** Provider-neutral text bridge. Nothing is called until the user requests generation. */
export function modelConfigFromEnv(env = process.env) {
  const model = env.MEDIA_DESK_MODEL?.trim()
  const baseUrl = env.MEDIA_DESK_BASE_URL?.trim()
  if (!model || !baseUrl) return null
  return {
    provider: 'openai-compatible', model, baseUrl,
    apiKey: env.MEDIA_DESK_API_KEY ?? '',
    timeoutMs: Number(env.MEDIA_DESK_MODEL_TIMEOUT_MS) || 240_000,
  }
}

function endpoint(baseUrl) {
  const value = new URL(baseUrl)
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash) {
    throw new Error('Text provider base URL must be an HTTP(S) URL without credentials, query or fragment')
  }
  value.pathname = value.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions'
  return value.href
}

function createSingleModelServices(config, { fetchImpl = fetch, signal: shutdownSignal } = {}) {
  if (!config?.model || !(config.generate || config.baseUrl)) return { llm: null, agentDefaultModel: null }
  const provider = config.provider || 'openai-compatible'
  const model = config.model
  const url = config.generate ? null : endpoint(config.baseUrl)
  const timeoutMs = Math.max(1_000, Math.min(Number(config.timeoutMs) || 240_000, 900_000))
  const generate = config.generate ?? (async ({ system, user, maxTokens, signal }) => {
    const response = await fetchImpl(url, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, stream: false }),
    })
    // Provider bodies may echo credentials or prompts. Do not expose those bodies in UI errors.
    if (!response.ok) throw new Error(`Text provider returned HTTP ${response.status}`)
    const value = await response.json()
    const content = value?.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(row => row?.type === 'text').map(row => row.text ?? '').join('') : ''
    if (!text.trim()) throw new Error('Text provider returned no text')
    return { text }
  })
  return {
    agentDefaultModel: { currentSelection: () => ({ provider, model }) },
    llm: {
      async listProviders() { return [{ id: provider, name: config.name || provider, ...(config.agentStatus ? { agentStatus: config.agentStatus } : {}) }] },
      async listModels(id) { return id === provider ? [{ id: model, name: config.label || model, ...(config.agentStatus ? { agentStatus: config.agentStatus } : {}) }] : [] },
      async prepareCall(selection, suppliedSignal, adjust) {
        if (selection.provider !== provider || selection.model !== model) throw new Error('The selected text model is not configured on this server')
        const controls = adjust ? adjust({ maxTokens: selection.maxTokens }, {}) : { maxTokens: selection.maxTokens }
        return {
          config: controls,
          async *stream(request) {
            const signals = [suppliedSignal, request.signal, shutdownSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean)
            const signal = AbortSignal.any(signals)
            signal.throwIfAborted()
            const user = request.messages.flatMap(message => message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n\n')
            const result = await generate({ system: request.system, user, model, maxTokens: request.maxTokens ?? selection.maxTokens, signal })
            signal.throwIfAborted()
            const text = typeof result === 'string' ? result : result?.text
            if (typeof text !== 'string' || !text.trim()) throw new Error('Text provider returned no text')
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
}

/** Multiple explicit providers reuse the original workbench's model picker. */
export function createModelServices(config, options = {}) {
  const configurations = (Array.isArray(config) ? config : [config]).filter(value => value?.model && (value.generate || value.baseUrl))
  if (!configurations.length) return { llm: null, agentDefaultModel: null }
  const entries = configurations.map(value => ({ config: value, services: createSingleModelServices(value, options) }))
  return {
    agentDefaultModel: entries[0].services.agentDefaultModel,
    llm: {
      async listProviders() {
        const providers = new Map()
        for (const entry of entries) for (const item of await entry.services.llm.listProviders()) providers.set(item.id, item)
        return [...providers.values()]
      },
      async listModels(provider) {
        const models = new Map()
        for (const entry of entries) for (const item of await entry.services.llm.listModels(provider)) models.set(item.id, item)
        return [...models.values()]
      },
      async prepareCall(selection, signal, adjust) {
        const entry = entries.find(value => (value.config.provider || 'openai-compatible') === selection.provider && value.config.model === selection.model)
        if (!entry) throw new Error('The selected text model is not configured on this server')
        return entry.services.llm.prepareCall(selection, signal, adjust)
      },
    },
  }
}
