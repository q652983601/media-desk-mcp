import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { hostname, homedir } from 'node:os'
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export function defaultDataDir(env = process.env) {
  return resolve(env.MEDIA_DESK_DATA_DIR || join(homedir(), '.local', 'share', 'morandi-media-desk'))
}

export function isLoopback(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)
}

export function equalToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  // Fixed-length digests avoid length-dependent timing and accept arbitrary token text safely.
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** Each contender creates its own marker before inspecting others. Only a sole live
 * contender may proceed; no contender ever removes another live process's lock. */
export async function acquireDataLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const dataDir = await realpath(directory)
  const locksDir = join(dataDir, '.server-locks')
  await mkdir(locksDir, { recursive: true, mode: 0o700 })
  const filename = `${process.pid}-${randomUUID()}.json`
  const lockPath = join(locksDir, filename)
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  try {
    for (const entry of await readdir(locksDir)) {
      if (entry === filename || !entry.endsWith('.json')) continue
      const path = join(locksDir, entry)
      let owner
      try { owner = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
        if (error.code === 'ENOENT') continue
        throw new Error('Another Media Desk instance is acquiring this data directory')
      }
      let alive = true
      if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
      }
      if (alive) throw new Error('This data directory is already owned by another Media Desk server; connect MCP clients to that server')
      // A marker has a unique name, so removing this dead PID's marker cannot
      // delete a concurrently acquired lock with the same filename.
      await rm(path, { force: true })
    }
    return { dataDir, release: () => rm(lockPath, { force: true }) }
  } catch (error) {
    await rm(lockPath, { force: true })
    throw error
  }
}

export function createRequestPolicy({ host, token, allowedHosts = [], getPort }) {
  if (!isLoopback(host) && !token) throw new Error('A non-loopback listener requires MEDIA_DESK_TOKEN')
  const names = new Set(['localhost', '127.0.0.1', '[::1]', ...(isLoopback(host) || !['0.0.0.0', '::', '[::]'].includes(host) ? [host] : []), ...allowedHosts])
  // Explicit names are authorities, including a portless HTTPS proxy Host.
  // Built-in localhost names still require the actual listener port.
  const explicitAuthorities = new Set(allowedHosts.map(value => value.toLowerCase()))
  function hostOriginRejection(headers) {
    let target
    try {
      if (typeof headers.host !== 'string' || /[\s/@\\]/.test(headers.host)) return 403
      target = new URL(`http://${headers.host}`)
    } catch { return 403 }
    const port = target.port || '80'
    const allowed = explicitAuthorities.has(target.host) || (names.has(target.hostname) && port === String(getPort()))
    if (!allowed) return 403
    if (headers.origin) {
      let origin
      try { origin = new URL(headers.origin) } catch { return 403 }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== target.host || origin.username || origin.password) return 403
    }
    const site = headers['sec-fetch-site']
    if (site && !['same-origin', 'none'].includes(site)) return 403
    return undefined
  }
  function authorized(headers) {
    if (!token) return true
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]
    let cookie
    try { cookie = decodeURIComponent((headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('media_desk_session='))?.slice('media_desk_session='.length) ?? '') } catch { cookie = '' }
    return equalToken(bearer, token) || equalToken(cookie, token)
  }
  return {
    hostOriginRejection, authorized,
    requestRejection({ headers }) { return hostOriginRejection(headers) || (authorized(headers) ? undefined : 401) },
  }
}
