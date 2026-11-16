import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createCliSettings } from '../standalone/cli-settings.mjs'
import { createStandaloneServer } from '../standalone/server.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-cli-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function providers(snapshot, id, changes) {
  return snapshot.providers.map(row => ({ id: row.id, enabled: row.enabled, command: row.command, models: row.models, ...(row.id === id ? changes : {}) }))
}

test('CLI configuration discovers four tools, persists atomically and rejects stale or invalid writes', async t => {
  const dataDir = await fixture(t)
  const manager = await createCliSettings({ dataDir, env: { PATH: '' }, onChange() {} })
  const initial = manager.read()
  assert.equal(initial.providers.length, 4)
  assert.equal(initial.providers.find(row => row.id === 'minimax').command, 'mmx')
  const body = { expectedRevision: initial.revision, providers: providers(initial, 'claude', { enabled: true, models: ['sonnet'] }) }
  const results = await Promise.allSettled([manager.save(body), manager.save(body)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].reason.status, 409)
  const restarted = await createCliSettings({ dataDir, env: { PATH: '' }, onChange() {} })
  assert.equal(restarted.read().providers.find(row => row.id === 'claude').enabled, true)
  const saved = await readFile(join(dataDir, 'cli.json'), 'utf8')
  await assert.rejects(manager.save({ expectedRevision: manager.read().revision, providers: providers(initial, 'claude', { models: ['bad model'] }) }), { status: 400 })
  assert.equal(await readFile(join(dataDir, 'cli.json'), 'utf8'), saved)
  const detected = manager.detect({ providers: providers(initial, 'claude', { command: process.execPath }) })
  assert.equal(detected.providers.find(row => row.id === 'claude').installed, true)
  assert.equal(manager.read().providers.find(row => row.id === 'claude').command, 'claude')
})

test('configuration changes wait for active CLI work and invalidate prepared old configurations', async t => {
  const dataDir = await fixture(t)
  const command = join(dataDir, 'codex-fixture')
  await writeFile(command, '#!/usr/bin/env node\nsetTimeout(() => { console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}})); console.log(JSON.stringify({type:"turn.completed"})); }, 200)\n')
  await chmod(command, 0o700)
  const manager = await createCliSettings({ dataDir, env: { ...process.env, MEDIA_DESK_AGENTS: 'codex', MEDIA_DESK_CODEX_COMMAND: command }, onChange() {} })
  const old = manager.configurations()[0]
  const pending = old.generate({ system: 'text', user: 'text' })
  await assert.rejects(manager.save({ expectedRevision: '0', providers: providers(manager.read(), 'codex', { enabled: false }) }), { status: 409 })
  await pending
  await manager.save({ expectedRevision: '0', providers: providers(manager.read(), 'codex', { enabled: false }) })
  await assert.rejects(old.generate({ system: 'text', user: 'text' }), { status: 409 })
})

test('HTTP settings apply immediately to the original model picker and survive restart', async t => {
  const dataDir = await fixture(t)
  const app = createStandaloneServer({ host: '127.0.0.1', port: 0, dataDir, env: { PATH: '' } })
  t.after(() => app.close())
  const address = await app.listen()
  const initial = await (await fetch(`${address.url}/media-desk/cli`)).json()
  const response = await fetch(`${address.url}/media-desk/cli`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: initial.revision, providers: initial.providers.map(row => ({ ...row, enabled: true })) }) })
  assert.equal(response.status, 200)
  const models = await (await fetch(`${address.url}/media-desk/models`)).json()
  assert.deepEqual(models.providers.map(row => row.provider), ['codex', 'kimi', 'claude', 'minimax'])
  await app.close()
  const restarted = createStandaloneServer({ host: '127.0.0.1', port: 0, dataDir, env: { PATH: '' } })
  t.after(() => restarted.close())
  const next = await restarted.listen()
  const saved = await (await fetch(`${next.url}/media-desk/cli`)).json()
  assert.ok(saved.providers.every(row => row.enabled))
})
