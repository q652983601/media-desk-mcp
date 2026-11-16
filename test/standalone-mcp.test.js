import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Store } from '../src/store.js'
import { applyOps } from '../src/ops.js'
import { importProduction, attachProductionAsset, productionRevision } from '../standalone/production-import.mjs'
import { createDeskClient } from '../standalone/mcp-tools.mjs'
import { readUploadAsset } from '../standalone/mcp-assets.mjs'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1kAAAAASUVORK5CYII='
const producer = { isRunning: () => false, anyAssetActive: () => false }

test('external agent production preserves original UI shape and detects stale edits from the UI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-import-test-'))
  try {
    const store = new Store(dir)
    const id = await store.mutate('fixture', state => applyOps(state, [{ op: 'add_item', title: 'AI 与人的创作' }]).receipts[0].target)
    const body = { id, expectedRevision: null, author: 'Codex', production: { title: '人的观察', article: '这是外部 Agent 写入的正文。', format: 'article', images: [{ prompt: 'A paper desk', caption: '工作台' }], shots: [{ visual: '桌面的笔记', voice: '从一个问题开始' }] } }
    const saved = await importProduction({ store, producer, body })
    assert.equal(saved.production.status, 'done')
    assert.equal(saved.production.engine, 'external:Codex')
    assert.equal(saved.production.images[0].status, 'skipped')
    assert.equal(saved.production.shots[0].no, 1)
    assert.equal(saved.status, 'draft')
    assert.equal(saved.revision, productionRevision(saved.production))
    await store.mutate('UI edit', state => applyOps(state, [{ op: 'update_production', id, article: '我刚刚在界面里改过。' }]))
    await assert.rejects(importProduction({ store, producer, body: { ...body, expectedRevision: saved.revision } }), error => error.status === 409)
    assert.equal((await store.read()).items.find(row => row.id === id).production.article, '我刚刚在界面里改过。')
    await assert.rejects(importProduction({ store, producer: { ...producer, isRunning: () => true }, body: { ...body, expectedRevision: undefined } }), error => error.status === 409)
    await assert.rejects(importProduction({ store, producer, body: { ...body, production: { ...body.production, savedPath: '/arbitrary/path' } } }), error => error.status === 400)
    await writeFile(join(store.filesDir, 'image.png'), Buffer.from(PNG, 'base64'))
    const current = (await store.read()).items.find(row => row.id === id).production
    const attached = await attachProductionAsset({ store, producer, body: { id, target: 'image:0', src: 'media-desk/files/image.png', expectedRevision: productionRevision(current) } })
    assert.equal(attached.asset.status, 'done')
    assert.equal(attached.asset.src, 'media-desk/files/image.png')
    await assert.rejects(attachProductionAsset({ store, producer, body: { id, target: 'cover', src: 'https://example.com/image.png' } }), error => error.status === 400)
    await assert.rejects(attachProductionAsset({ store, producer, body: { id, target: 'cover', src: 'media-desk/files/missing.png' } }), error => error.status === 404)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('image import is scoped to configured directories and checks image bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-upload-test-'))
  try {
    const allowed = join(dir, 'allowed')
    await mkdir(allowed)
    const file = join(allowed, 'image.png')
    const outside = join(dir, 'outside.png')
    await writeFile(file, Buffer.from(PNG, 'base64'))
    await writeFile(outside, Buffer.from(PNG, 'base64'))
    const uploaded = await readUploadAsset({ filePath: file }, { importRoots: [allowed] })
    assert.equal(uploaded.mimeType, 'image/png')
    assert.equal(uploaded.bytes.toString('base64'), PNG)
    await assert.rejects(readUploadAsset({ filePath: outside }, { importRoots: [allowed] }), /outside/)
    await symlink(outside, join(allowed, 'escape.png'))
    await assert.rejects(readUploadAsset({ filePath: join(allowed, 'escape.png') }, { importRoots: [allowed] }), /outside/)
    await assert.rejects(readUploadAsset({ filePath: file }, { importRoots: [] }), /disabled/)
    await assert.rejects(readUploadAsset({ base64: Buffer.from('not an image').toString('base64') }), /Only PNG/)
    await assert.rejects(readUploadAsset({ base64: `${PNG}garbage` }), /base64/)
    assert.equal((await readUploadAsset({ base64: PNG })).mimeType, 'image/png')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('MCP HTTP client only uses an origin, refuses credential-bearing URLs and does not follow redirects', async () => {
  assert.throws(() => createDeskClient({ baseUrl: 'http://user:secret@localhost:4318' }), /without credentials/)
  assert.throws(() => createDeskClient({ baseUrl: 'http://localhost:4318/other' }), /without credentials/)
  assert.throws(() => createDeskClient({ publicUrl: 'https://private:token@desk.example' }), /without credentials/)
  const links = createDeskClient({ baseUrl: 'http://127.0.0.1:4319', publicUrl: 'https://desk.example/' })
  assert.equal(links.baseUrl, 'http://127.0.0.1:4319')
  assert.equal(links.publicUrl, 'https://desk.example')
  let received
  const api = createDeskClient({ baseUrl: 'http://127.0.0.1:4318', token: 'private-test-token', fetchImpl: async (url, options) => {
    received = { url, options }
    return new Response(JSON.stringify({ state: { items: [], apiKey: 'not-exposed' } }), { status: 200 })
  } })
  assert.deepEqual(await api.state(), { items: [] })
  assert.equal(received.options.redirect, 'error')
  assert.equal(received.options.headers.authorization, 'Bearer private-test-token')
})

// The integration test below starts the real standalone service and uses the
// official SDK over child-process stdio and HTTP, never an in-memory MCP stub.
async function connectStdio(baseUrl, token, importRoots) {
  const client = new Client({ name: 'media-desk-integration', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('standalone/mcp.mjs')], cwd: process.cwd(), stderr: 'pipe',
    env: { PATH: process.env.PATH, MEDIA_DESK_URL: baseUrl, MEDIA_DESK_TOKEN: token, MEDIA_DESK_IMPORT_ROOTS: importRoots || '' },
  })
  let stderr = ''
  transport.stderr.on('data', chunk => { stderr += chunk })
  await client.connect(transport)
  return { client, transport, stderr: () => stderr }
}

function result(result) {
  assert.ok(!result.isError, result.content?.map(row => row.text || '').join('\n'))
  return result.structuredContent ?? JSON.parse(result.content[0].text)
}

test('real stdio and Streamable HTTP clients share state, production, assets, and revision conflicts', { timeout: 30000 }, async () => {
  const { createStandaloneServer } = await import('../standalone/server.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'desk-mcp-integration-'))
  const token = 'integration-token-no-real-secret'
  let app, a, b, httpClient
  try {
    app = createStandaloneServer({ dataDir: dir, host: '127.0.0.1', port: 0, token, modelConfig: null, publicUrl: 'https://desk.example' })
    const { url: baseUrl } = await app.listen()
    a = await connectStdio(baseUrl, token, dir)
    b = await connectStdio(baseUrl, token, dir)
    const listing = await a.client.listTools()
    assert.ok(listing.tools.some(tool => tool.name === 'media_desk_write_production'))
    assert.ok(listing.tools.some(tool => tool.name === 'media_desk_upload_asset'))
    const resources = await a.client.listResources()
    assert.ok(resources.resources.some(row => row.uri === 'media-desk://writing-context'))
    const context = await a.client.readResource({ uri: 'media-desk://writing-context' })
    assert.ok(context.contents[0].text)
    const created = result(await a.client.callTool({ name: 'media_desk_save_idea', arguments: { title: 'MCP 与原界面共用内容', body: '两位 Agent 一起完成。' } }))
    const id = created.item.id
    const crossRead = result(await b.client.callTool({ name: 'media_desk_get_item', arguments: { id } }))
    assert.equal(crossRead.item.title, 'MCP 与原界面共用内容')
    assert.equal(crossRead.productionRevision, null)
    const imported = result(await a.client.callTool({ name: 'media_desk_write_production', arguments: {
      id, expectedRevision: null, author: 'Codex', production: { title: '成稿已出现', article: '由外部 AI 写好，再存入工作台。', format: 'article', images: [{ caption: '真实测试图片', prompt: 'A small square' }] },
    } }))
    assert.equal(imported.production.engine, 'external:Codex')
    const uiRead = await fetch(`${baseUrl}/media-desk/state`, { headers: { authorization: `Bearer ${token}` } }).then(res => res.json())
    assert.equal(uiRead.state.items.find(row => row.id === id).production.article, '由外部 AI 写好，再存入工作台。')
    const imageFile = join(dir, 'agent-output.png')
    await writeFile(imageFile, Buffer.from(PNG, 'base64'))
    const uploaded = result(await a.client.callTool({ name: 'media_desk_upload_asset', arguments: { filePath: imageFile } }))
    assert.match(uploaded.src, /^media-desk\/files\/.+\.png$/)
    const attached = result(await b.client.callTool({ name: 'media_desk_attach_asset', arguments: { id, target: 'image:0', src: uploaded.src, expectedRevision: imported.revision } }))
    assert.equal(attached.asset.status, 'done')
    const stale = await a.client.callTool({ name: 'media_desk_write_production', arguments: { id, expectedRevision: imported.revision, production: { title: 'stale', article: 'Must not overwrite' } } })
    assert.equal(stale.isError, true)
    await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? a : b).client.callTool({ name: 'media_desk_save_idea', arguments: { title: `Concurrent ${index}` } })))
    const concurrent = result(await a.client.callTool({ name: 'media_desk_list_items', arguments: { query: 'Concurrent ', limit: 100 } }))
    assert.equal(concurrent.items.length, 10)
    httpClient = new Client({ name: 'http-integration', version: '1.0.0' })
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    const open = result(await httpClient.callTool({ name: 'media_desk_open', arguments: {} }))
    assert.equal(open.url, 'https://desk.example/')
    const viaHttp = result(await httpClient.callTool({ name: 'media_desk_get_item', arguments: { id } }))
    assert.equal(viaHttp.item.production.images[0].src, uploaded.src)
    assert.equal(viaHttp.productionRevision, attached.revision)
    assert.ok(!a.stderr().includes(token))
    assert.ok(!b.stderr().includes(token))
    const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.ok(persisted.items.some(row => row.id === id))
  } finally {
    await httpClient?.close()
    await a?.client.close()
    await b?.client.close()
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
