import React from 'react'
import { loadDesk } from '../client/desk.js'

async function request(body, action = '') {
  const response = await fetch(`/media-desk/magpie${action}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Magpie 请求失败。')
  return value
}

export function MagpieSettings({ onClose, onBusy }) {
  const [data, setData] = React.useState(null)
  const [apiKey, setApiKey] = React.useState('')
  const [clearKey, setClearKey] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')

  const reload = async () => {
    setError('')
    try { setData(await request()); setApiKey(''); setClearKey(false) } catch (reason) { setError(reason.message) }
  }
  React.useEffect(() => {
    let cancelled = false
    request().then(value => { if (!cancelled) setData(value) }).catch(reason => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [])

  const patch = changes => setData(value => ({ ...value, ...changes }))
  const setWorking = value => { setBusy(value); onBusy(value) }
  const discover = async () => {
    setWorking(true)
    setError('')
    setNotice('')
    try {
      const result = await request({ baseUrl: data.baseUrl, apiKey, clearKey }, '/models')
      setData(value => ({ ...value, ...result, model: result.models.some(row => row.id === value.model) ? value.model : '', reasoningEffort: '' }))
      setNotice(`已连接 Magpie，读取到 ${result.models.length} 个模型和路由组。`)
    } catch (reason) { setError(reason.message) } finally { setWorking(false) }
  }
  const save = async event => {
    event.preventDefault()
    setWorking(true)
    setError('')
    try {
      await request({ ...data, expectedRevision: data.revision, apiKey, clearKey })
      await loadDesk()
      onClose(true)
    } catch (reason) { setError(reason.message) } finally { setWorking(false) }
  }

  const selected = data?.models.find(row => row.id === data.model)
  const visibleModels = data?.models.filter(row => row.id === data.model || `${row.id} ${row.name}`.toLowerCase().includes(search.toLowerCase())) ?? []

  return <form className="md-form" onSubmit={save}>
    <p className="md-muted md-cli-intro">通过 Magpie 统一选择模型与路由组，账号和额度由 Magpie 管理。</p>
    {!data && !error ? <p role="status">正在读取 Magpie 配置…</p> : null}
    {data ? <fieldset className="md-magpie-fields" disabled={busy}>
      <label className="md-cli-status"><input type="checkbox" checked={data.enabled} onChange={event => patch({ enabled: event.target.checked })} />启用 Magpie</label>
      <label className="md-field"><span>网关地址</span><input type="url" aria-label="Magpie 网关地址" value={data.baseUrl} onChange={event => { patch({ baseUrl: event.target.value, models: [], model: '', reasoningEffort: '' }); setNotice('') }} required placeholder="http://127.0.0.1:3425/v1" /></label>
      <label className="md-field"><span>网关密钥{data.hasKey ? '（已保存）' : '（本机默认可留空）'}</span><input type="password" autoComplete="off" aria-label="Magpie 网关密钥" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={data.hasKey ? '留空沿用已保存密钥' : '远程网关按实际配置填写'} /></label>
      {data.hasKey ? <label className="md-cli-status"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />清除已保存的网关密钥</label> : null}
      <div><button type="button" className="md-btn" onClick={discover}>读取 / 刷新模型</button></div>
      {notice ? <p className="md-muted md-cli-intro" role="status">{notice}</p> : null}
      {data.models.length ? <label className="md-field"><span>搜索模型或路由组</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称或模型 ID" /></label> : null}
      <label className="md-field"><span>写作模型 / 路由组</span><select aria-label="Magpie 写作模型" value={data.model} onChange={event => patch({ model: event.target.value, reasoningEffort: '' })} required={data.enabled}>
        <option value="">{data.models.length ? '请选择模型或路由组' : '先读取 Magpie 模型列表'}</option>
        {data.model && !selected ? <option value={data.model}>{data.model}</option> : null}
        {visibleModels.map(row => <option key={row.id} value={row.id}>{row.name === row.id ? row.id : `${row.name} · ${row.id}`}</option>)}
      </select></label>
      {selected?.reasoningEfforts?.length ? <label className="md-field"><span>推理强度</span><select aria-label="Magpie 推理强度" value={data.reasoningEffort} onChange={event => patch({ reasoningEffort: event.target.value })}>
        <option value="">跟随模型默认</option>
        {selected.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </select></label> : null}
      {data.fetchedAt ? <small className="md-muted">模型列表由当前 Magpie 网关提供。保存后会用于助手和成稿。</small> : null}
    </fieldset> : null}
    {error ? <div className="md-field"><p className="md-cli-error" role="alert">{error}</p><button type="button" className="md-btn" onClick={reload} disabled={busy}>重新读取配置</button></div> : null}
    <div className="md-form-foot"><span style={{ flex: 1 }} /><button type="button" className="md-btn" disabled={busy} onClick={() => onClose(false)}>取消</button><button type="submit" className="md-btn is-primary" disabled={busy || !data}>{busy ? '正在处理…' : '保存并应用'}</button></div>
  </form>
}
