import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { createStandaloneServer } from '../standalone/server.mjs'
import { createModelServices } from '../standalone/model.mjs'
import { createRequestPolicy } from '../standalone/runtime.mjs'
import { Producer } from '../src/produce.js'

async function fixture(run, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'media-desk-standalone-'))
  const webRoot = join(dataDir, 'web')
  await mkdir(webRoot)
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Standalone test</title>')
  await writeFile(join(webRoot, 'app.js'), 'window.standaloneTest=true')
  const app = createStandaloneServer({ dataDir, webRoot, host: '127.0.0.1', port: 0, modelConfig: null, ...options })
  try {
    const { url } = await app.listen()
    const request = async (path, body, headers = {}) => {
      const response = await fetch(`${url}${path}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'content-type': 'application/json', ...headers } })
      return { status: response.status, body: await response.json(), response }
    }
    await run({ app, dataDir, webRoot, url, request })
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('standalone serves the original HTTP contract, imports external work and persists without DSH', async () => fixture(async ({ app, dataDir, url, request }) => {
  assert.match(await (await fetch(url)).text(), /Standalone test/)
  const initial = await request('/media-desk/state')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.model, null)
  const results = await Promise.all(['A', 'B'].map(title => request('/media-desk/ops', { ops: [{ op: 'add_item', title }] })))
  assert.ok(results.every(result => result.status === 200))
  const id = results[0].body.receipts[0].target
  const imported = await request('/media-desk/production/import', { id, expectedRevision: null, author: 'test-agent', production: { title: 'External work', article: 'A complete externally written article.', format: 'article' } })
  assert.equal(imported.status, 200)
  const production = await request(`/media-desk/production?id=${id}`)
  assert.equal(production.body.production.article, 'A complete externally written article.')
  assert.match(production.body.revision, /^[a-f\d]{64}$/)
  const outdated = await request('/media-desk/production/import', { id, expectedRevision: null, production: { title: 'Stale write', article: 'Must not overwrite' } })
  assert.equal(outdated.status, 409)
  const version = await request('/media-desk/version')
  assert.equal(version.body.updateAvailable, false)
  assert.equal(version.body.channel, 'standalone')
  assert.equal((await request('/media-desk/monid/import', { text: 'anything' })).status, 403)
  await request('/media-desk/ops', { ops: [{ op: 'add_skill', name: 'My writing rule', rule: 'Use concrete examples.', status: 'active' }] })
  const exported = await request('/media-desk/skills/export', {})
  assert.equal(exported.status, 200)
  assert.ok(exported.body.path.startsWith(dataDir + '/'))
  assert.match(await readFile(exported.body.path, 'utf8'), /Use concrete examples/)
  await app.close()
  const state = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'))
  assert.ok(state.items.some(item => item.title === 'A'))
  assert.ok(state.items.some(item => item.title === 'B'))
  assert.equal(state.items.find(item => item.id === id).production.title, 'External work')
}))

test('Host, Origin and tokens are checked; UI can obtain an HttpOnly session cookie', async () => fixture(async ({ url, request }) => {
  assert.equal((await request('/media-desk/state')).status, 401)
  assert.equal((await request('/media-desk/state', undefined, { authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await request('/media-desk/state', undefined, { authorization: 'Bearer fixture-token' })).status, 200)
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/media-desk/state`, { headers: { authorization: 'Bearer fixture-token', host: 'evil.example:4319' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(badHostStatus, 403)
  assert.equal((await request('/media-desk/state', undefined, { authorization: 'Bearer fixture-token', origin: 'https://evil.example' })).status, 403)
  assert.equal((await request('/media-desk/ops', { ops: [] }, { authorization: 'Bearer fixture-token', 'sec-fetch-site': 'cross-site' })).status, 403)
  const login = await fetch(url)
  assert.equal(login.status, 401)
  assert.match(await login.text(), /action="\/session"/)
  const session = await fetch(`${url}/session`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: url }, body: 'token=fixture-token', redirect: 'manual' })
  assert.equal(session.status, 303)
  const cookie = session.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.equal((await request('/media-desk/state', undefined, { cookie: cookie.split(';')[0] })).status, 200)
}, { token: 'fixture-token' }))

test('a non-loopback listener fails closed without a token', () => {
  assert.throws(() => createStandaloneServer({ host: '0.0.0.0', token: '', env: {} }), /requires MEDIA_DESK_TOKEN/)
  const policy = createRequestPolicy({ host: '0.0.0.0', token: 'test', allowedHosts: ['media.example.com'], getPort: () => 4319 })
  assert.equal(policy.hostOriginRejection({ host: 'media.example.com', origin: 'https://media.example.com' }), undefined)
  assert.equal(policy.hostOriginRejection({ host: 'localhost:1234' }), 403)
  assert.equal(policy.hostOriginRejection({ host: 'attacker.example.com', origin: 'https://attacker.example.com' }), 403)
})

test('only one server may own a data directory and a clean restart preserves it', async () => fixture(async ({ app, dataDir }) => {
  const second = createStandaloneServer({ dataDir, host: '127.0.0.1', port: 0, modelConfig: null })
  await assert.rejects(second.listen(), /already owned/)
  await second.close()
  const before = (await app.runtime.store.read()).items.length
  await app.close()
  const restarted = createStandaloneServer({ dataDir, host: '127.0.0.1', port: 0, modelConfig: null })
  try {
    await restarted.listen()
    assert.equal((await restarted.runtime.store.read()).items.length, before)
  } finally { await restarted.close() }
}))

test('concurrent settings edits are serialized and retain both fields', async () => fixture(async ({ app }) => {
  await Promise.all([app.runtime.settings.update({ voice: 'Keep my voice.' }), app.runtime.settings.update({ imageCount: 4 })])
  const settings = await app.runtime.settings.read()
  assert.equal(settings.voice, 'Keep my voice.')
  assert.equal(settings.imageCount, 4)
}))

test('Producer reserves jobs and individual assets before yielding and releases failed starts', async () => {
  const state = { items: [{ id: 'one', title: 'One', production: { cover: { prompt: 'A scene' } } }], draftFormat: 'article' }
  const store = { read: async () => state, mutate: async (_label, fn) => fn(state) }
  const settings = { read: async () => ({ generateImages: false }) }
  const producer = new Producer({ store, settings, ready: () => true, callText: async () => ({ text: '' }), generate: async () => ({}) })
  let runs = 0, finish
  producer.run = () => { runs++; return new Promise(resolve => { finish = resolve }) }
  assert.deepEqual(await Promise.all([producer.start('one'), producer.start('one')]), [true, false])
  assert.equal(runs, 1)
  await assert.rejects(producer.regenerate('one', 'cover'), error => error.status === 409)
  const job = producer.jobs.get('one')
  finish()
  await job.promise
  assert.equal(producer.isRunning('one'), false)
  await assert.rejects(producer.start('missing'), /找不到/)
  assert.equal(producer.isRunning('missing'), false)
  state.items[0].production.cover = { prompt: 'A scene' }
  let assets = 0, finishAsset
  producer.renderAsset = () => { assets++; return new Promise(resolve => { finishAsset = resolve }) }
  await Promise.all([producer.regenerate('one', 'cover'), producer.regenerate('one', 'cover')])
  assert.equal(assets, 1)
  assert.equal(await producer.start('one'), false)
  const asset = producer.assetJobs.get('one:cover')
  finishAsset()
  await asset.promise
  assert.equal(producer.assets.size, 0)
})

test('generic text adapter sends the configured OpenAI-compatible contract and supports external agents', async () => {
  let calls = 0
  const services = createModelServices([
    { provider: 'http', model: 'fixture-model', baseUrl: 'https://model.example/v1', apiKey: 'private-key' },
    { provider: 'codex', model: 'configured-cli', generate: async ({ user }) => ({ text: `CLI: ${user}` }) },
  ], { fetchImpl: async (url, request) => {
    calls++
    assert.equal(url, 'https://model.example/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer private-key')
    const body = JSON.parse(request.body)
    assert.equal(body.max_tokens, 123)
    assert.equal(body.stream, false)
    assert.equal(body.messages[0].content, 'System')
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic completion' } }] }), { headers: { 'content-type': 'application/json' } })
  } })
  assert.deepEqual((await services.llm.listProviders()).map(value => value.id), ['http', 'codex'])
  assert.equal(calls, 0)
  const http = await services.llm.prepareCall({ provider: 'http', model: 'fixture-model', maxTokens: 123 })
  const request = { ...http.config, system: 'System', messages: [{ role: 'user', content: [{ type: 'text', text: 'User' }] }] }
  const chunks = []
  for await (const chunk of http.stream(request)) chunks.push(chunk)
  assert.equal(chunks[0].text, 'Synthetic completion')
  assert.equal(calls, 1)
  const cli = await services.llm.prepareCall({ provider: 'codex', model: 'configured-cli', maxTokens: 10 })
  for await (const chunk of cli.stream(request)) if (chunk.type === 'text-delta') assert.equal(chunk.text, 'CLI: User')
  await assert.rejects(services.llm.prepareCall({ provider: 'other', model: 'unknown' }), /not configured/)
})
