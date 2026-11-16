import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMagpieSettings, normalizeMagpieModels } from '../standalone/magpie.mjs'
import { createModelServices } from '../standalone/model.mjs'
import { createStandaloneServer } from '../standalone/server.mjs'

const catalog = [
  { id: 'group/write', display_name: 'Writing', reasoning_levels: ['low', 'high'], secret: 'must-not-return' },
  { id: 'codex/model', display_name: 'Model', supported_reasoning_levels: [{ effort: 'medium' }] },
  { id: 'image/model', modalities: { output: ['image'] } },
]

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-magpie-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function payload(manager, changes = {}) {
  const saved = manager.read()
  return { ...saved, expectedRevision: saved.revision, enabled: true, model: 'group/write', models: catalog, ...changes }
}

test('Magpie catalog retains IDs/names/efforts and filters explicit non-text output', () => {
  const normalized = normalizeMagpieModels(catalog)
  assert.deepEqual(normalized, [
    { id: 'group/write', name: 'Writing', reasoningEfforts: ['low', 'high'] },
    { id: 'codex/model', name: 'Model', reasoningEfforts: ['medium'] },
  ])
})

test('discovery uses the gateway models endpoint and never returns provider secrets', async t => {
  const dataDir = await directory(t)
  const seen = []
  const manager = await createMagpieSettings({ dataDir, env: { MAGPIE_GATEWAY_KEY: 'private-gateway-key' }, onChange() {}, fetchImpl: async (url, options) => {
    seen.push({ url, options })
    return Response.json({ data: catalog })
  } })
  const result = await manager.discover({ baseUrl: 'http://127.0.0.1:3425' })
  assert.equal(seen[0].url, 'http://127.0.0.1:3425/v1/models')
  assert.equal(seen[0].options.headers.authorization, 'Bearer private-gateway-key')
  assert.equal(seen[0].options.redirect, 'error')
  assert.equal(result.models.length, 2)
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.ok(!JSON.stringify(manager.read()).includes('private-gateway-key'))
  await manager.discover({ baseUrl: 'https://other.example/v1' })
  assert.equal(seen[1].options.headers.authorization, undefined)
})

test('settings persist with revisions, selected model and secret redaction', async t => {
  const dataDir = await directory(t)
  let changes = 0
  const manager = await createMagpieSettings({ dataDir, env: {}, onChange() { changes += 1 } })
  const body = payload(manager, { apiKey: 'private-token', reasoningEffort: 'high' })
  const responses = await Promise.allSettled([manager.save(body), manager.save(body)])
  assert.equal(responses[0].status, 'fulfilled')
  assert.equal(responses[1].reason.status, 409)
  assert.equal(changes, 1)
  assert.ok(!JSON.stringify(manager.read()).includes('private-token'))
  assert.equal(manager.read().hasKey, true)
  const restarted = await createMagpieSettings({ dataDir, env: {}, onChange() {} })
  assert.equal(restarted.read().model, 'group/write')
  const before = await readFile(join(dataDir, 'magpie.json'), 'utf8')
  await assert.rejects(manager.save(payload(manager, { reasoningEffort: 'invalid' })), { status: 400 })
  assert.equal(await readFile(join(dataDir, 'magpie.json'), 'utf8'), before)
})

test('discovery stops an oversized catalog and sanitizes connection failures', async t => {
  const dataDir = await directory(t)
  const large = await createMagpieSettings({ dataDir, env: {}, onChange() {}, fetchImpl: async () => new Response('x'.repeat(2_000_001)) })
  await assert.rejects(large.discover({ baseUrl: 'http://localhost:3425' }), { status: 502 })
  const failed = await createMagpieSettings({ dataDir, env: {}, onChange() {}, fetchImpl: async () => { throw new Error('private-gateway-key') } })
  await assert.rejects(failed.discover({ baseUrl: 'http://localhost:3425' }), error => error.status === 502 && !error.message.includes('private-gateway-key'))
})

test('gateway generation reuses Chat Completions, sends selected effort and guards active calls', async t => {
  const manager = await createMagpieSettings({ dataDir: await directory(t), env: {}, onChange() {} })
  await manager.save(payload(manager, { reasoningEffort: 'high' }))
  let complete, started
  const entered = new Promise(resolve => { started = resolve })
  const services = createModelServices(manager.configurations(), { fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3425/v1/chat/completions')
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'group/write')
    assert.equal(body.reasoning_effort, 'high')
    started()
    return new Promise(resolve => { complete = () => resolve(Response.json({ choices: [{ message: { content: 'Completed text' } }] })) })
  } })
  const call = await services.llm.prepareCall({ provider: 'magpie', model: 'group/write' })
  const consume = async () => { const frames = []; for await (const frame of call.stream({ system: '', messages: [] })) frames.push(frame); return frames }
  const pending = consume()
  await entered
  await assert.rejects(manager.save(payload(manager)), { status: 409 })
  complete()
  assert.equal((await pending)[0].text, 'Completed text')
  const oldCall = await services.llm.prepareCall({ provider: 'magpie', model: 'group/write' })
  await manager.save(payload(manager, { enabled: false }))
  await assert.rejects(async () => { for await (const frame of oldCall.stream({ messages: [] })) void frame }, { status: 409 })
})

test('HTTP Magpie save selects its model and preserves existing CLI configuration', async t => {
  const app = createStandaloneServer({ host: '127.0.0.1', port: 0, dataDir: await directory(t), env: {}, fetchImpl: async () => Response.json({ data: catalog }) })
  t.after(() => app.close())
  const address = await app.listen()
  const url = `${address.url}/media-desk/magpie`
  const before = await (await fetch(url)).json()
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post(`${url}/models`, { baseUrl: before.baseUrl })).status, 200)
  const saved = await post(url, { ...before, enabled: true, expectedRevision: before.revision, model: 'group/write', models: catalog })
  assert.equal(saved.status, 200)
  const models = await (await fetch(`${address.url}/media-desk/models`)).json()
  assert.equal(models.providers[0].provider, 'magpie')
  assert.equal(models.current.model, 'group/write')
  const cli = await (await fetch(`${address.url}/media-desk/cli`)).json()
  assert.equal(cli.providers.length, 4)
})
