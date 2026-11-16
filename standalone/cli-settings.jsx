import React from 'react'
import { createPortal } from 'react-dom'
import { loadDesk, setDesk, useDesk } from '../client/desk.js'
import { Dialog } from '../client/ui.jsx'
import { MagpieSettings } from './magpie-settings.jsx'

async function request(body, action = '') {
  const response = await fetch(`/media-desk/cli${action}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || '无法读取 CLI 配置。')
  return value
}

/** Add a settings entry through the standalone shell, preserving upstream files. */
export function CliSettings() {
  const settingsOpen = useDesk(value => value.settingsOpen)
  const [anchor, setAnchor] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const [data, setData] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [tab, setTab] = React.useState('magpie')

  React.useEffect(() => {
    if (!settingsOpen) return
    let slot
    const attach = () => {
      const form = document.querySelector('.md-dialog form.md-form')
      if (!form || slot) return
      slot = document.createElement('div')
      form.prepend(slot)
      setAnchor(slot)
    }
    attach()
    const observer = new MutationObserver(attach)
    observer.observe(document.getElementById('app'), { childList: true, subtree: true })
    return () => { observer.disconnect(); slot?.remove(); setAnchor(null) }
  }, [settingsOpen])

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setData(null)
    setError('')
    request().then(value => {
      if (!cancelled) setData({ ...value, providers: value.providers.map(row => ({ ...row, modelText: row.models.join(', ') })) })
    }).catch(reason => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [open])

  const close = (completed = false) => { if (!busy || completed) { setOpen(false); setDesk({ settingsOpen: true }) } }
  const patch = (id, changes) => setData(value => ({ ...value, providers: value.providers.map(row => row.id === id ? { ...row, ...changes } : row) }))
  const providers = () => data.providers.map(row => ({ id: row.id, enabled: row.enabled, command: row.command, models: row.modelText.split(',').map(model => model.trim()).filter(Boolean) }))
  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      const detected = await request({ providers: providers() }, '/detect')
      setData(value => ({ ...value, providers: value.providers.map(row => {
        const saved = detected.providers.find(item => item.id === row.id)
        return { ...row, installed: saved.installed, resolvedCommand: saved.resolvedCommand }
      }) }))
    } catch (reason) { setError(reason.message) } finally { setBusy(false) }
  }
  const save = async event => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request({
        expectedRevision: data.revision,
        providers: providers(),
      })
      await loadDesk()
      setOpen(false)
      setDesk({ settingsOpen: true })
    } catch (reason) { setError(reason.message) } finally { setBusy(false) }
  }

  return <>
    {anchor ? createPortal(<div className="md-cli-entry md-field">
      <span>文字模型</span>
      <button type="button" className="md-btn" onClick={() => { setDesk({ settingsOpen: false }); setTab('magpie'); setOpen(true) }}>配置 Magpie 模型与 CLI</button>
    </div>, anchor) : null}
    {open ? <div className="md-root md-cli-root"><Dialog title="模型配置" width={600} onClose={() => close()}>
      <div className="md-presets md-provider-tabs" role="tablist" aria-label="模型接入方式">
        <button type="button" role="tab" aria-selected={tab === 'magpie'} disabled={busy} className={tab === 'magpie' ? 'is-on' : ''} onClick={() => setTab('magpie')}>Magpie 网关</button>
        <button type="button" role="tab" aria-selected={tab === 'cli'} disabled={busy} className={tab === 'cli' ? 'is-on' : ''} onClick={() => setTab('cli')}>本机 CLI</button>
      </div>
      {tab === 'magpie' ? <MagpieSettings onClose={close} onBusy={setBusy} /> : <form className="md-form" onSubmit={save}>
        <p className="md-muted md-cli-intro">CLI 在工作台所在电脑运行，使用该系统用户已有的登录或凭据配置。保存后立即应用，可在顶栏「助手模型」中切换。</p>
        {!data && !error ? <p role="status">正在检测 CLI…</p> : null}
        {data?.providers.map(row => <fieldset className="md-cli-provider" key={row.id} disabled={busy}>
          <legend>{row.name}</legend>
          <div className="md-cli-status">
            <label><input type="checkbox" checked={row.enabled} onChange={event => patch(row.id, { enabled: event.target.checked })} />启用</label>
            <span>{row.installed === null ? '路径已修改 · 请重新检测' : row.installed ? '已安装 · 登录待验证' : '未找到可执行文件'}</span>
          </div>
          <label className="md-field"><span>可执行文件 · {row.id}</span><input aria-label={`${row.name} 可执行文件`} value={row.command} onChange={event => patch(row.id, { command: event.target.value, installed: null, resolvedCommand: null })} required spellCheck={false} /></label>
          {row.resolvedCommand ? <small className="md-cli-path">{row.resolvedCommand}</small> : null}
          <label className="md-field"><span>模型 ID · {row.id}</span><input aria-label={`${row.name} 模型`} value={row.modelText} onChange={event => patch(row.id, { modelText: event.target.value })} placeholder="default" required spellCheck={false} /></label>
        </fieldset>)}
        <p className="md-muted md-cli-intro">多个模型用英文逗号分隔，default 沿用 CLI 默认。MiniMax 使用 mmx text chat。检测只检查可执行文件，实际生成会使用对应账号额度。</p>
        {error ? <div className="md-field"><p className="md-cli-error" role="alert">{error}</p><button type="button" className="md-btn" disabled={busy} onClick={async () => {
          setBusy(true)
          try {
            const value = await request()
            setData({ ...value, providers: value.providers.map(row => ({ ...row, modelText: row.models.join(', ') })) })
            setError('')
          } catch (reason) { setError(reason.message) } finally { setBusy(false) }
        }}>重新读取配置</button></div> : null}
        <div className="md-form-foot">
          <button type="button" className="md-btn" onClick={refresh} disabled={busy || !data}>重新检测</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="md-btn" onClick={close} disabled={busy}>取消</button>
          <button type="submit" className="md-btn is-primary" disabled={busy || !data}>{busy ? '正在保存…' : '保存并应用'}</button>
        </div>
      </form>}
    </Dialog></div> : null}
  </>
}
