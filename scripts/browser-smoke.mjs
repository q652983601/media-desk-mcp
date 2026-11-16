// Real standalone HTTP + MCP SDK + unchanged React UI. No model or user data.
// Run after: npm ci && npm run build:standalone && npx playwright install --with-deps chromium
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createStandaloneServer } from '../standalone/server.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT = 12_000 // External-state polling runs every two seconds.
const CASES = [
  { name: 'desktop-light', theme: 'light', viewport: { width: 1440, height: 1000 } },
  { name: 'desktop-dark', theme: 'dark', viewport: { width: 1440, height: 1000 } },
  { name: 'mobile-light', theme: 'light', viewport: { width: 390, height: 844 }, mobile: true },
  { name: 'mobile-dark', theme: 'dark', viewport: { width: 390, height: 844 }, mobile: true },
]

function unwrap(result) {
  assert.ok(!result.isError, result.content?.map(row => row.text || '').join('\n') || 'MCP tool failed')
  return result.structuredContent ?? JSON.parse(result.content.find(row => row.type === 'text').text)
}

async function inViewport(locator, viewport, description) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert.ok(box && box.width > 0 && box.height > 0, `${description} has no rendered box`)
  assert.ok(box.x < viewport.width && box.x + box.width > 0 && box.y < viewport.height && box.y + box.height > 0,
    `${description} is outside the viewport: ${JSON.stringify(box)}`)
}

// These selectors are taken from client/index.jsx, content.jsx, schedule.jsx,
// insights.jsx and style.jsx. Scope to the navigation because labels such as
// “灵感” and “风格” also occur in cards, dialogs and the studio.
async function visit(page, label) {
  const nav = page.getByRole('navigation', { name: '工作台导航', exact: true })
  const button = nav.getByRole('button', { name: label, exact: true })
  await button.click()
  assert.equal(await button.getAttribute('aria-current'), 'page', `${label} did not become the active view`)
  const main = page.getByRole('main')
  if (label === '灵感') await main.getByRole('textbox', { name: '记下灵感', exact: true }).waitFor()
  if (label === '内容') await main.getByRole('heading', { name: '内容', level: 1, exact: true }).waitFor()
  if (label === '排期') {
    await main.getByRole('grid').waitFor()
    assert.ok(await main.getByRole('gridcell').count() >= 28, 'Calendar did not render its month cells')
  }
  if (label === '复盘') await main.getByRole('button', { name: '录入数据', exact: true }).waitFor()
  if (label === '风格') await main.getByRole('tablist', { name: '博主类型', exact: true }).waitFor()
}

async function checkShell(page, spec) {
  const root = page.locator('.md-root')
  await root.waitFor()
  await page.waitForFunction(mobile => document.querySelector('.md-root')?.classList.contains('is-compact') === mobile, Boolean(spec.mobile))
  const metrics = await root.evaluate(element => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return {
      width: box.width, height: box.height, background: style.backgroundColor,
      ink: style.color, radius: style.getPropertyValue('--dsw-radius-md').trim(),
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      scheme: document.documentElement.style.colorScheme,
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
    }
  })
  assert.equal(metrics.dark, spec.theme === 'dark')
  assert.equal(metrics.scheme, spec.theme)
  assert.ok(Math.abs(metrics.width - spec.viewport.width) <= 1 && Math.abs(metrics.height - spec.viewport.height) <= 1,
    `Workbench does not fill ${spec.name}: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.radius, 'Vendored theme tokens were not loaded')
  assert.ok(metrics.background !== 'rgba(0, 0, 0, 0)' && metrics.background !== metrics.ink, 'Theme colors did not resolve')
  assert.ok(metrics.pageWidth <= metrics.viewportWidth + 1, 'The document overflows horizontally')
  if (spec.mobile) await page.locator('.md-dock').waitFor({ state: 'detached' })
  return metrics
}

async function runCase(browser, mcp, baseUrl, spec, report, diagnostics) {
  const context = await browser.newContext({
    viewport: spec.viewport, isMobile: Boolean(spec.mobile), hasTouch: Boolean(spec.mobile),
    deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'UTC',
    colorScheme: spec.theme, reducedMotion: 'reduce', serviceWorkers: 'block',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(TIMEOUT)
  page.setDefaultNavigationTimeout(20_000)
  const entry = { case: spec.name, console: [], pageErrors: [], failedRequests: [], badResponses: [], externalRequests: [], stateResponses: 0, navigations: 0 }
  report.push(entry)
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) entry.console.push({ type: message.type(), text: message.text(), location: message.location() })
  })
  page.on('pageerror', error => entry.pageErrors.push(error.stack || error.message))
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) entry.navigations += 1 })
  page.on('requestfailed', request => entry.failedRequests.push({ url: request.url(), resourceType: request.resourceType(), error: request.failure()?.errorText }))
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path === '/media-desk/state' && response.ok()) entry.stateResponses += 1
    if (response.status() >= 400) entry.badResponses.push({ url: response.url(), status: response.status() })
  })
  // No third-party request is needed by this UI. Never let a regression turn
  // the smoke run into an external service call. Only the optional browser
  // favicon is answered here; every application route uses the real server.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
    if (url.origin !== baseUrl) {
      entry.externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' })
    return route.continue()
  })

  try {
    const response = await page.goto(`${baseUrl}/?lang=zh&theme=${spec.theme}`, { waitUntil: 'domcontentloaded' })
    assert.equal(response.status(), 200, 'Standalone HTML did not load')
    await page.getByRole('main').getByRole('textbox', { name: '记下灵感', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'Polling requires a foreground/visible document')
    entry.shell = await checkShell(page, spec)
    const nav = page.getByRole('navigation', { name: '工作台导航', exact: true })
    assert.equal(await nav.getByRole('button').count(), 5)
    for (const label of ['灵感', '内容', '排期', '复盘', '风格']) await visit(page, label)
    await visit(page, '内容')

    // The page is already mounted and remains on Content throughout both MCP
    // writes. No reload, browser-side fetch, or direct store injection is used.
    const navigationCount = entry.navigations
    const stateReadsBefore = entry.stateResponses
    const ideaTitle = `Smoke idea ${spec.name}`
    const title = `MCP 成稿 ${spec.name}`
    const firstText = `第一版正文 ${spec.name}：通过真实 MCP 写入。`
    const secondText = `第二版正文 ${spec.name}：原工作区已轮询到外部修改。`
    const created = unwrap(await mcp.callTool({ name: 'media_desk_save_idea', arguments: { title: ideaTitle, body: '浏览器 smoke 的临时测试素材。' } }))
    const saved = unwrap(await mcp.callTool({ name: 'media_desk_write_production', arguments: {
      id: created.item.id, expectedRevision: null, author: 'browser-smoke',
      production: { title, article: firstText, format: 'article' },
    } }))
    // BoardCard displays production.title; Table intentionally uses item.title.
    const card = page.locator('.md-board-card').filter({ has: page.getByText(title, { exact: true }) })
    await card.waitFor()
    assert.ok(entry.stateResponses > stateReadsBefore, 'No state poll observed after the MCP write')
    assert.equal(entry.navigations, navigationCount, 'MCP content should appear without navigation/reload')
    await card.click() // Also exercises horizontal board scrolling on a phone.

    const studio = page.getByRole('dialog', { name: '灵感', exact: true })
    await studio.waitFor()
    const article = studio.locator('.md-tile-article')
    const heading = article.getByRole('heading', { name: title, level: 1, exact: true })
    await heading.waitFor()
    await inViewport(heading, spec.viewport, 'Studio article title')
    await article.locator('.md-prose').filter({ hasText: firstText }).waitFor()
    const beforeStudioUpdate = entry.stateResponses
    unwrap(await mcp.callTool({ name: 'media_desk_write_production', arguments: {
      id: created.item.id, expectedRevision: saved.revision, author: 'browser-smoke',
      production: { title, article: secondText, format: 'article' },
    } }))
    const prose = article.locator('.md-prose').filter({ hasText: secondText })
    await prose.waitFor()
    assert.ok(!(await prose.textContent()).includes(firstText), 'Studio retained the stale article')
    assert.ok(entry.stateResponses > beforeStudioUpdate, 'Open Studio did not receive another state poll')
    assert.equal(entry.navigations, navigationCount, 'Open Studio updated by reloading instead of polling')
    await inViewport(prose, spec.viewport, 'Updated article body')

    if (spec.mobile) {
      const toggle = studio.getByRole('button', { name: '打开对话', exact: true })
      await inViewport(toggle, spec.viewport, 'Mobile studio drawer button')
      await toggle.click()
      await page.locator('.md-studio.chat-open').waitFor()
    }
    const back = studio.getByRole('button', { name: '返回灵感', exact: true })
    await inViewport(back, spec.viewport, 'Studio return button')
    await back.click()
    await studio.waitFor({ state: 'detached' })

    // Verify the original accessible table toggle and keyboard row behavior,
    // including on the narrow layout where the five-column board scrolls.
    const display = page.getByRole('radiogroup', { name: '显示方式', exact: true })
    await display.getByRole('radio', { name: '表格', exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: ideaTitle })
    await row.waitFor()
    await row.focus()
    await row.press('Enter')
    await studio.waitFor()
    await studio.locator('.md-prose').filter({ hasText: secondText }).waitFor()

    assert.deepEqual(entry.pageErrors, [], 'Browser page errors')
    assert.deepEqual(entry.console.filter(message => message.type === 'error'), [], 'Browser console errors')
    assert.deepEqual(entry.badResponses, [], 'Application HTTP errors')
    // Changing views can cancel an image that was still loading. Preserve the
    // event for diagnostics, but fail on actual application/network failures.
    assert.deepEqual(entry.failedRequests.filter(request => !(request.error === 'net::ERR_ABORTED' && ['image', 'media', 'font'].includes(request.resourceType))), [], 'Failed browser requests')
    assert.deepEqual(entry.externalRequests, [], 'Unexpected third-party requests')
    entry.ok = true
    if (entry.console.length) console.warn(`${spec.name} browser warnings: ${JSON.stringify(entry.console)}`)
    console.log(`PASS ${spec.name}: five views, theme, MCP → Content → Studio, live polling, table keyboard navigation`)
    return entry.shell
  } catch (error) {
    entry.failure = error.stack || String(error)
    await mkdir(diagnostics, { recursive: true })
    if (!page.isClosed()) await page.screenshot({ path: join(diagnostics, `${spec.name}.png`), fullPage: true, timeout: 5000 }).catch(() => {})
    throw error
  } finally {
    await context.close()
  }
}

async function main() {
  for (const file of ['app.js', 'index.html']) {
    await access(join(ROOT, 'dist', 'standalone', file)).catch(() => {
      throw new Error('Build the standalone frontend first: npm run build:standalone')
    })
  }
  const temporary = await mkdtemp(join(tmpdir(), 'media-desk-browser-smoke-'))
  const dataDir = join(temporary, 'data')
  const diagnostics = join(temporary, 'diagnostics')
  const report = []
  let app, browser, mcp, passed = false
  try {
    app = createStandaloneServer({ dataDir, host: '127.0.0.1', port: 0, token: '', modelConfig: null, allowMonid: false, env: {} })
    const { url: baseUrl } = await app.listen()
    mcp = new Client({ name: 'media-desk-browser-smoke', version: '1.0.0' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)))
    browser = await chromium.launch({ headless: true })
    const themes = new Map()
    for (const spec of CASES) themes.set(spec.name, await runCase(browser, mcp, baseUrl, spec, report, diagnostics))
    for (const device of ['desktop', 'mobile']) {
      assert.notEqual(themes.get(`${device}-light`).background, themes.get(`${device}-dark`).background, `${device}: dark mode changed its attribute but not its rendered background`)
    }
    passed = true
    console.log('Browser smoke passed: 4 viewport/theme combinations; real MCP SDK; zero model calls.')
  } catch (error) {
    await mkdir(diagnostics, { recursive: true })
    await writeFile(join(diagnostics, 'report.json'), JSON.stringify({ error: error.stack || String(error), cases: report }, null, 2))
    console.error(`Browser smoke failed. Temporary diagnostics: ${diagnostics}`)
    if (report.length) console.error(JSON.stringify(report, null, 2))
    throw error
  } finally {
    await Promise.allSettled([browser?.close(), mcp?.close()])
    try { await app?.close() } finally {
      // Always remove the temporary workspace, including failed runs. Failure
      // diagnostics contain only this script's fixture and remain under tmpdir.
      await rm(dataDir, { recursive: true, force: true })
      if (passed) await rm(temporary, { recursive: true, force: true })
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
