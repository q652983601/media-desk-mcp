// External agents can contribute finished work without asking the service to
// call a second model. Assets must already belong to this workspace.
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'

const text = (max = 40000) => z.string().max(max)
const id = z.string().min(1).max(160)
const mediaPath = z.string().max(2000).regex(/^media-desk\/(?:assets|files)\/[\w.-]+\.(?:png|jpe?g|gif|webp)$/i)
const assetInput = z.object({ prompt: text(1200).optional(), src: mediaPath.optional() }).strict()
export const productionInput = z.object({
  title: text(200).trim().min(1), article: text(200000).trim().min(1),
  format: z.enum(['article', 'script']).default('article'), coverText: text(40).optional(),
  cover: assetInput.optional(), facts: z.array(text(500)).max(20).optional(),
  outline: z.array(text(500)).max(30).optional(), characters: text(2000).optional(),
  images: z.array(assetInput.extend({ caption: text(200).optional(), anchor: text(200).optional() }).strict()).max(8).optional(),
  shots: z.array(assetInput.extend({
    no: z.number().int().min(1).max(24).optional(), shot: text(80).optional(),
    visual: text(2000).optional(), voice: text(2000).optional(), seconds: z.number().min(1).max(60).optional(),
  }).strict()).max(24).optional(),
}).strict()

const importInput = z.object({
  id, production: productionInput, expectedRevision: z.string().max(200).nullable().optional(),
  author: text(200).default('external-agent'),
}).strict()
const attachInput = z.object({
  id, target: z.string().regex(/^(?:cover|image:[0-7]|shot:(?:[0-9]|1[0-9]|2[0-3]))$/),
  src: mediaPath, expectedRevision: z.string().max(200).nullable().optional(),
}).strict()
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const parse = (schema, body) => {
  const result = schema.safeParse(body)
  if (!result.success) throw fail(`Invalid production input: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  return result.data
}

export function productionRevision(production) {
  return production ? createHash('sha256').update(JSON.stringify(production)).digest('hex') : null
}

async function checkAsset(src, store) {
  if (!src) return
  const match = /^media-desk\/(assets|files)\/([\w.-]+)$/.exec(src)
  if (!match || match[2] === '.' || match[2] === '..') throw fail('Invalid asset path')
  const root = match[1] === 'assets' ? ASSETS_DIR : store.filesDir
  let realRoot, realFile, info
  try {
    [realRoot, realFile, info] = await Promise.all([realpath(root), realpath(join(root, match[2])), stat(join(root, match[2]))])
  } catch { throw fail(`Asset does not exist: ${src}`, 404) }
  const rel = relative(realRoot, realFile)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !info.isFile()) throw fail('Asset must be a regular workspace file')
}

function guardTarget(item, producer, body) {
  if (!item) throw fail('Item not found', 404)
  if (producer.isRunning(body.id) || producer.anyAssetActive?.(body.id)) throw fail('This item has a running generation; finish or cancel it before importing', 409)
  if (body.expectedRevision !== undefined && body.expectedRevision !== productionRevision(item.production)) {
    throw fail('Production changed since it was read. Read the item again and reconcile the edit.', 409)
  }
}

function normalizeAsset(asset = {}) {
  return { ...asset, prompt: asset.prompt ?? '', status: asset.src ? 'done' : 'skipped' }
}

export async function importProduction({ store, producer, body }) {
  const input = parse(importInput, body)
  // Disk checks precede the queue; recheck the generation and content revision
  // inside the same serialized mutation that commits the replacement.
  await store.read()
  const p = input.production
  await Promise.all([p.cover, ...(p.images ?? []), ...(p.shots ?? [])].map(asset => checkAsset(asset?.src, store)))
  const result = await store.mutate('外部 Agent 保存成稿', state => {
    const item = state.items.find(row => row.id === input.id)
    guardTarget(item, producer, input)
    const previous = item.production
    const now = new Date().toISOString()
    item.production = {
      status: 'done', stage: 'done', startedAt: now, finishedAt: now,
      title: p.title, article: p.article, aiArticle: p.article,
      format: p.format, coverText: p.coverText ?? p.title.slice(0, 24),
      facts: p.facts ?? [], outline: p.outline ?? [], characters: p.characters ?? '',
      cover: normalizeAsset(p.cover), images: (p.images ?? []).map(normalizeAsset),
      shots: (p.shots ?? []).map((shot, index) => ({ ...normalizeAsset(shot), no: index + 1, seconds: shot.seconds ?? 5 })),
      withImages: [p.cover, ...(p.images ?? []), ...(p.shots ?? [])].some(asset => Boolean(asset?.src)),
      engine: `external:${input.author}`, source: 'external-agent',
      ...(previous?.savedPath ? { savedPath: previous.savedPath, savedHashes: previous.savedHashes } : {}),
    }
    if (['idea', 'outline'].includes(item.status)) item.status = item.scheduledAt ? 'ready' : 'draft'
    return { id: item.id, production: structuredClone(item.production), revision: productionRevision(item.production), status: item.status }
  })
  return result
}

export async function attachProductionAsset({ store, producer, body }) {
  const input = parse(attachInput, body)
  await store.read()
  await checkAsset(input.src, store)
  return store.mutate('外部 Agent 添加图片', state => {
    const item = state.items.find(row => row.id === input.id)
    guardTarget(item, producer, input)
    if (!item.production) throw fail('Write the production before attaching its image', 409)
    let asset
    if (input.target === 'cover') {
      item.production.cover ??= { prompt: '' }
      asset = item.production.cover
    } else {
      const [kind, index] = input.target.split(':')
      asset = (kind === 'image' ? item.production.images : item.production.shots)?.[Number(index)]
    }
    if (!asset) throw fail('Asset target does not exist; add it to the production plan first', 404)
    asset.src = input.src
    asset.status = 'done'
    delete asset.error
    item.production.withImages = true
    return { id: item.id, target: input.target, asset: structuredClone(asset), revision: productionRevision(item.production) }
  })
}
