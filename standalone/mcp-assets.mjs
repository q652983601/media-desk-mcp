import { readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, relative, isAbsolute } from 'node:path'

export const MAX_ASSET_BYTES = 20 * 1024 * 1024

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  throw new Error('Only PNG, JPEG, GIF, or WebP image bytes are accepted')
}

export async function readUploadAsset({ filePath, base64 }, { importRoots = process.env.MEDIA_DESK_IMPORT_ROOTS || '' } = {}) {
  if (Boolean(filePath) === Boolean(base64)) throw new Error('Provide exactly one of filePath or base64')
  let bytes
  if (filePath) {
    const roots = Array.isArray(importRoots) ? importRoots : importRoots.split(delimiter).filter(Boolean)
    if (!roots.length) throw new Error('Local file imports are disabled. Configure MEDIA_DESK_IMPORT_ROOTS on the MCP process, or send image bytes as base64.')
    const file = await realpath(filePath)
    const canonicalRoots = await Promise.all(roots.map(root => realpath(root)))
    if (!canonicalRoots.some(root => {
      const rel = relative(root, file)
      return rel && !rel.startsWith('..') && !isAbsolute(rel)
    })) throw new Error('Image path is outside the configured import directories')
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) throw new Error('Image must be a regular file smaller than 20 MiB')
    bytes = await readFile(file)
  } else {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new Error('Image base64 is invalid')
    bytes = Buffer.from(base64, 'base64')
    if (bytes.toString('base64') !== base64) throw new Error('Image base64 is invalid')
  }
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw new Error('Image must be smaller than 20 MiB')
  return { bytes, mimeType: imageType(bytes) }
}
