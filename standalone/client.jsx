// Mount the original Media Desk component without a DSH runtime or module loader.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { apply } from '../client/index.jsx'
import { getDesk, setDesk } from '../client/desk.js'
import { lang } from '../client/i18n.js'
import base from './theme/base.css'
import palette from './theme/design-platform.css'
import elevation from './theme/gradient-shadow-text.css'
import corners from './theme/corner-shape.css'
import scrollbars from './theme/scrollbar.css'
import shell from './theme.css'
import { CliSettings } from './cli-settings.jsx'

const themeStyle = document.createElement('style')
themeStyle.dataset.mediaDeskTheme = '39163dd30f703a79079e2d2446545cff3c453738'
themeStyle.textContent = [base, palette, elevation, corners, scrollbars, shell].join('\n')
document.head.append(themeStyle)

const query = new URLSearchParams(window.location.search)
const preferredLanguage = query.get('lang')
if (preferredLanguage === 'zh' || preferredLanguage === 'en') {
  document.documentElement.lang = preferredLanguage
}
const preferredTheme = query.get('theme')
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
function updateTheme() {
  const dark = preferredTheme === 'dark' || (preferredTheme !== 'light' && systemTheme.matches)
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
updateTheme()
systemTheme.addEventListener('change', updateTheme)

const root = createRoot(document.getElementById('app'))
const effects = new Set()
const noop = () => {}
// The only host calls made by client/index.jsx are slot registration and effects.
// Capture its original Desk component; sidebar registrations have no standalone role.
apply({
  slots: {
    inject(_name, callback) { return callback() },
    register(slot, Component) {
      if (slot.name === 'main' && slot.key === 'media-desk') root.render(<><Component /><CliSettings /></>)
      return noop
    },
  },
  effect(callback) {
    const cleanup = callback()
    if (typeof cleanup === 'function') effects.add(cleanup)
    return cleanup
  },
  inject: noop,
})

// MCP clients and this UI share the server store. Refresh external edits without
// replacing the upstream frontend, stealing focus, or racing its optimistic edits.
let synchronizing = false
async function syncExternalChanges() {
  const before = getDesk()
  const active = document.activeElement
  const editing = active?.matches('input, textarea, select') || active?.isContentEditable
  if (synchronizing || document.hidden || !before.state || before.thinking || editing ||
      before.dialog || before.capture || before.settingsOpen || before.modelPickOpen) return
  synchronizing = true
  try {
    const response = await fetch('media-desk/state', {
      headers: { 'x-media-desk-lang': lang() }, cache: 'no-store',
    })
    if (!response.ok) return
    const data = await response.json()
    if (getDesk() !== before) return
    const patch = {
      state: data.state, model: data.model, modelOk: data.modelOk,
      modelError: data.modelError, canUndo: data.canUndo,
    }
    if (Object.entries(patch).some(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value))) {
      setDesk(patch)
    }
  } catch {
    // Existing UI actions report errors; a disconnected tab retries quietly.
  } finally {
    synchronizing = false
  }
}
const syncTimer = setInterval(syncExternalChanges, 2000)
window.addEventListener('focus', syncExternalChanges)
document.addEventListener('visibilitychange', syncExternalChanges)
window.addEventListener('pagehide', event => {
  if (event.persisted) return
  clearInterval(syncTimer)
  systemTheme.removeEventListener('change', updateTheme)
  window.removeEventListener('focus', syncExternalChanges)
  document.removeEventListener('visibilitychange', syncExternalChanges)
  for (const cleanup of effects) cleanup()
}, { once: true })
