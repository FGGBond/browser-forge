import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'

let browser
let server
let baseUrl

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    if (req.url === '/api/chrome-path') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ path: '/Applications/Google Chrome.app' }))
      return
    }
    if (req.url?.startsWith('/api/screenshots/')) {
      res.setHeader('content-type', 'image/png')
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw9p8wAAAABJRU5ErkJggg==', 'base64'))
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(readFileSync(join(process.cwd(), 'ui/index.html')))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('Artifacts screenshot gallery', () => {
  it('hides the custom titlebar when running inside the Electron shell', async () => {
    const page = await browser.newPage()
    await page.goto(`${baseUrl}?shell=electron`, { waitUntil: 'networkidle' })

    const layout = await page.evaluate(() => ({
      bodyClass: document.body.className,
      titlebarDisplay: getComputedStyle(document.querySelector('.titlebar')).display,
      rows: getComputedStyle(document.querySelector('.app-window')).gridTemplateRows
    }))

    expect(layout.bodyClass).toContain('shell-electron')
    expect(layout.titlebarDisplay).toBe('none')
    expect(layout.rows).not.toContain('34px')

    await page.close()
  })

  it('centers the done stage and hides prior recording chrome on narrow screens', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 640, height: 620 })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const layout = await page.evaluate(() => {
      window.showView('done')
      document.getElementById('session-path').textContent = '/Users/example/output/session-2026-07-25-0951'
      const panelRect = document.getElementById('view-done').getBoundingClientRect()
      const windowRect = document.querySelector('.app-window').getBoundingClientRect()
      const bodyRect = document.querySelector('.app-body').getBoundingClientRect()
      return {
        bodyClass: document.body.className,
        sidebarDisplay: getComputedStyle(document.querySelector('.sidebar')).display,
        resizerDisplay: getComputedStyle(document.querySelector('.sidebar-resizer')).display,
        toolbarDisplay: getComputedStyle(document.querySelector('.toolbar')).display,
        statusbarDisplay: getComputedStyle(document.querySelector('.statusbar')).display,
        panelCenterX: Math.round(panelRect.left + panelRect.width / 2),
        windowCenterX: Math.round(bodyRect.left + bodyRect.width / 2),
        panelCenterY: Math.round(panelRect.top + panelRect.height / 2),
        windowCenterY: Math.round(bodyRect.top + bodyRect.height / 2),
        panelRight: Math.round(panelRect.right),
        windowRight: Math.round(windowRect.right)
      }
    })

    expect(layout.bodyClass).toContain('view-done')
    expect(layout.sidebarDisplay).toBe('none')
    expect(layout.resizerDisplay).toBe('none')
    expect(layout.toolbarDisplay).toBe('none')
    expect(layout.statusbarDisplay).toBe('none')
    expect(Math.abs(layout.panelCenterX - layout.windowCenterX)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.panelCenterY - layout.windowCenterY)).toBeLessThanOrEqual(2)
    expect(layout.panelRight).toBeLessThanOrEqual(layout.windowRight - 20)

    await page.close()
  })

  it('removes nonessential toolbar actions and shortcut hints', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const result = await page.evaluate(() => ({
      iconButtons: document.querySelectorAll('.icon-button').length,
      titleActions: document.querySelectorAll('.title-actions').length,
      text: document.body.textContent
    }))

    expect(result.iconButtons).toBe(0)
    expect(result.titleActions).toBe(0)
    expect(result.text).not.toContain('⌘K')
    expect(result.text).not.toContain('⌕')
    expect(result.text).not.toContain('⤓')

    await page.close()
  })

  it('uses stable card columns with compact left-aligned responsive gaps', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const grid = await page.evaluate(() => {
      const rules = Array.from(document.styleSheets[0].cssRules)
      const rule = rules.find(item => item.selectorText === '.screenshot-grid')
      const probe = document.createElement('div')
      probe.className = 'screenshot-grid'
      document.body.appendChild(probe)
      const style = getComputedStyle(probe)
      return {
        cssText: rule?.cssText,
        columnGap: parseFloat(style.columnGap),
        justifyContent: style.justifyContent
      }
    })

    expect(grid.cssText).toContain('minmax(min(100%, 220px), 220px)')
    expect(grid.cssText).toContain('clamp(')
    expect(grid.justifyContent).toBe('start')
    expect(grid.columnGap).toBeLessThanOrEqual(8)

    await page.close()
  })

  it('renders dimension tabs in artifact, network, console, events order', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    await page.evaluate(() => {
      window.showView('recording')
      window.updateSummary({
        type: 'summary',
        updatedAt: Date.now(),
        totals: { events: 4, network: 3, console: 2, artifacts: 1 },
        tabs: [{
          targetId: 'tab-1',
          title: 'Docs',
          url: 'https://docs.test',
          counts: { events: 4, network: 3, console: 2, artifacts: 1 },
          artifacts: { screenshots: [] },
          recent: { events: [], network: [], console: [], artifacts: [] }
        }]
      })
    })

    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.dimension-tab .dimension-label')).map(node => node.textContent)
    )

    expect(labels).toEqual(['Artifacts', 'Network', 'Console', 'Events'])

    await page.close()
  })

  it('keeps newest screenshot first, shows thumbnails only, and marks moved thumbnails', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    await page.evaluate(() => {
      window.showView('recording')
      window.selectDimension('artifacts')
      window.updateSummary(createSummary([
        { timestamp: 100, thumbnailUrl: '/api/screenshots/tab-1/100.png' }
      ], { artifacts: 1 }))
      window.updateSummary(createSummary([
        { timestamp: 100, thumbnailUrl: '/api/screenshots/tab-1/100.png' },
        { timestamp: 200, thumbnailUrl: '/api/screenshots/tab-1/200.png' }
      ], { artifacts: 2 }))

      function createSummary(screenshots, counts) {
        return {
          type: 'summary',
          updatedAt: Date.now(),
          totals: { events: counts.events ?? 0, network: 0, console: 0, artifacts: counts.artifacts },
          tabs: [{
            targetId: 'tab-1',
            title: 'Docs',
            url: 'https://docs.test',
            counts: { events: counts.events ?? 0, network: 0, console: 0, artifacts: counts.artifacts },
            artifacts: {
              screenshots: screenshots.map(item => ({
                timestamp: item.timestamp,
                kind: 'Screenshot',
                title: `screenshot-${item.timestamp}.png`,
                thumbnailUrl: item.thumbnailUrl
              }))
            },
            recent: { events: [], network: [], console: [], artifacts: [] }
          }]
        }
      }
    })

    const result = await page.evaluate(() => ({
      sources: Array.from(document.querySelectorAll('.screenshot-card img')).map(img => img.getAttribute('src')),
      captions: document.querySelectorAll('.screenshot-meta, figcaption').length,
      times: Array.from(document.querySelectorAll('.screenshot-time')).map(node => node.textContent),
      newCards: Array.from(document.querySelectorAll('.screenshot-card.is-new')).map(card => card.dataset.screenshotId),
      shiftedCards: Array.from(document.querySelectorAll('.screenshot-card.is-shifted')).map(card => card.dataset.screenshotId)
    }))

    expect(result.sources).toEqual([
      '/api/screenshots/tab-1/200.png',
      '/api/screenshots/tab-1/100.png'
    ])
    expect(result.captions).toBe(0)
    expect(result.times).toHaveLength(2)
    expect(result.newCards).toEqual(['200'])
    expect(result.shiftedCards).toEqual(['100'])

    await page.close()
  })

  it('hides DOM and script artifact links while keeping screenshot timestamps', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    await page.evaluate(() => {
      window.showView('recording')
      window.selectDimension('artifacts')
      window.updateSummary({
        type: 'summary',
        updatedAt: Date.now(),
        totals: { events: 0, network: 0, console: 0, artifacts: 3 },
        tabs: [{
          targetId: 'tab-1',
          title: 'Docs',
          url: 'https://docs.test',
          counts: { events: 0, network: 0, console: 0, artifacts: 3 },
          artifacts: {
            screenshots: [{
              timestamp: 1784940000000,
              kind: 'Screenshot',
              title: 'screenshot-1784940000000.png',
              thumbnailUrl: '/api/screenshots/tab-1/1784940000000.png'
            }]
          },
          recent: {
            events: [],
            network: [],
            console: [],
            artifacts: [
              { time: 1784940000000, kind: 'DOM', title: 'https://docs.test', detail: 'snapshot' },
              { time: null, kind: 'Script', title: 'https://docs.test/app.js', detail: 'hash' }
            ]
          }
        }]
      })
    })

    const result = await page.evaluate(() => ({
      text: document.getElementById('dimension-log').textContent,
      screenshotTimes: Array.from(document.querySelectorAll('.screenshot-time')).map(node => node.textContent)
    }))

    expect(result.text).not.toContain('https://docs.test')
    expect(result.text).not.toContain('app.js')
    expect(result.screenshotTimes).toHaveLength(1)
    expect(result.screenshotTimes[0]).toMatch(/:/)

    await page.close()
  })

  it('adds movement offsets so older thumbnails animate backward after a new screenshot arrives', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    await page.evaluate(() => {
      window.__thumbnailAnimations = []
      const originalAnimate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        if (this.classList?.contains('screenshot-card')) {
          window.__thumbnailAnimations.push({
            id: this.dataset.screenshotId,
            keyframes,
            options
          })
        }
        return originalAnimate.call(this, keyframes, options)
      }
      window.showView('recording')
      window.selectDimension('artifacts')
      window.updateSummary(createSummary([
        { timestamp: 100, thumbnailUrl: '/api/screenshots/tab-1/100.png' }
      ], { artifacts: 1 }))
      window.updateSummary(createSummary([
        { timestamp: 100, thumbnailUrl: '/api/screenshots/tab-1/100.png' },
        { timestamp: 200, thumbnailUrl: '/api/screenshots/tab-1/200.png' }
      ], { artifacts: 2 }))

      function createSummary(screenshots, counts) {
        return {
          type: 'summary',
          updatedAt: Date.now(),
          totals: { events: 0, network: 0, console: 0, artifacts: counts.artifacts },
          tabs: [{
            targetId: 'tab-1',
            title: 'Docs',
            url: 'https://docs.test',
            counts: { events: 0, network: 0, console: 0, artifacts: counts.artifacts },
            artifacts: {
              screenshots: screenshots.map(item => ({
                timestamp: item.timestamp,
                kind: 'Screenshot',
                title: `screenshot-${item.timestamp}.png`,
                thumbnailUrl: item.thumbnailUrl
              }))
            },
            recent: { events: [], network: [], console: [], artifacts: [] }
          }]
        }
      }
    })

    const moved = await page.evaluate(() => {
      const card = document.querySelector('.screenshot-card[data-screenshot-id="100"]')
      const animation = window.__thumbnailAnimations.find(item => item.id === '100')
      return {
        moveX: card?.style.getPropertyValue('--move-x'),
        moveY: card?.style.getPropertyValue('--move-y'),
        animation
      }
    })

    expect(moved.moveX || moved.moveY).not.toBe('')
    expect(moved.animation.options.duration).toBe(240)
    expect(moved.animation.options.easing).toBe('cubic-bezier(0.77, 0, 0.175, 1)')

    await page.close()
  })

  it('renders changed dimension counts as a digit reel that rolls to the new value', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    await page.evaluate(() => {
      window.showView('recording')
      window.updateSummary(createSummary(12))
      window.updateSummary(createSummary(34))

      function createSummary(events) {
        return {
          type: 'summary',
          updatedAt: Date.now(),
          totals: { events, network: 0, console: 0, artifacts: 0 },
          tabs: [{
            targetId: 'tab-1',
            title: 'Docs',
            url: 'https://docs.test',
            counts: { events, network: 0, console: 0, artifacts: 0 },
            artifacts: { screenshots: [] },
            recent: { events: [], network: [], console: [], artifacts: [] }
          }]
        }
      }
    })

    const result = await page.evaluate(() => {
      const eventsTab = Array.from(document.querySelectorAll('.dimension-tab'))
        .find(tab => tab.textContent.includes('Events'))
      return {
        hasRollingClass: eventsTab.querySelector('.count')?.classList.contains('is-rolling'),
        target: eventsTab.querySelector('.count')?.dataset.target,
        durations: Array.from(eventsTab.querySelectorAll('.count-reel')).map(node => getComputedStyle(node).animationDuration),
        delays: Array.from(eventsTab.querySelectorAll('.count-reel')).map(node => getComputedStyle(node).animationDelay),
        reelValues: Array.from(eventsTab.querySelectorAll('.count-digit')).map(digit =>
          Array.from(digit.querySelectorAll('.count-reel span')).map(node => node.textContent)
        ),
        translates: Array.from(eventsTab.querySelectorAll('.count-reel')).map(node => node.style.transform)
      }
    })

    expect(result.hasRollingClass).toBe(true)
    expect(result.target).toBe('34')
    expect(result.durations).toEqual(['2.4s', '1.2s'])
    expect(result.delays).toEqual(['0s', '0.12s'])
    expect(result.reelValues).toEqual([
      ['0', '1', '2', '3'],
      ['0', '1', '2', '3', '4']
    ])
    expect(result.translates).toEqual(['translateY(-48px)', 'translateY(-64px)'])

    await page.close()
  })

  it('keeps count and thumbnail animations after a redundant tabs refresh', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    await page.evaluate(() => {
      window.showView('recording')
      window.selectDimension('artifacts')
      window.updateSummary(createSummary([
        { timestamp: 100, thumbnailUrl: '/api/screenshots/tab-1/100.png' }
      ], 1))
      const nextSummary = createSummary([
        { timestamp: 100, thumbnailUrl: '/api/screenshots/tab-1/100.png' },
        { timestamp: 200, thumbnailUrl: '/api/screenshots/tab-1/200.png' }
      ], 2)
      window.updateSummary(nextSummary)
      window.updateTabs(nextSummary.tabs)

      function createSummary(screenshots, artifacts) {
        return {
          type: 'summary',
          updatedAt: Date.now(),
          totals: { events: artifacts, network: 0, console: 0, artifacts },
          tabs: [{
            targetId: 'tab-1',
            title: 'Docs',
            url: 'https://docs.test',
            counts: { events: artifacts, network: 0, console: 0, artifacts },
            artifacts: {
              screenshots: screenshots.map(item => ({
                timestamp: item.timestamp,
                kind: 'Screenshot',
                title: `screenshot-${item.timestamp}.png`,
                thumbnailUrl: item.thumbnailUrl
              }))
            },
            recent: { events: [], network: [], console: [], artifacts: [] }
          }]
        }
      }
    })

    const result = await page.evaluate(() => {
      const eventsTab = Array.from(document.querySelectorAll('.dimension-tab'))
        .find(tab => tab.textContent.includes('Events'))
      return {
        hasRollingCount: eventsTab.querySelector('.count')?.classList.contains('is-rolling'),
        newCards: Array.from(document.querySelectorAll('.screenshot-card.is-new')).map(card => card.dataset.screenshotId),
        shiftedCards: Array.from(document.querySelectorAll('.screenshot-card.is-shifted')).map(card => card.dataset.screenshotId)
      }
    })

    expect(result.hasRollingCount).toBe(true)
    expect(result.newCards).toEqual(['200'])
    expect(result.shiftedCards).toEqual(['100'])

    await page.close()
  })

  it('gates hover states to fine pointer devices', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const hasGatedHover = await page.evaluate(() =>
      Array.from(document.styleSheets[0].cssRules).some(rule =>
        rule.conditionText?.includes('hover: hover') &&
        rule.conditionText?.includes('pointer: fine') &&
        Array.from(rule.cssRules).some(child => child.selectorText === '.button:hover')
      )
    )

    expect(hasGatedHover).toBe(true)

    await page.close()
  })

  it('keeps gentle opacity feedback but removes transform motion for reduced motion users', async () => {
    const page = await browser.newPage()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const reduced = await page.evaluate(() => {
      const buttonStyle = getComputedStyle(document.querySelector('.button'))
      const imageStyle = getComputedStyle(document.querySelector('.screenshot-thumb img') || document.body)
      return {
        transitionProperty: buttonStyle.transitionProperty,
        transitionDuration: buttonStyle.transitionDuration,
        imageTransform: imageStyle.transform
      }
    })

    expect(reduced.transitionProperty).toContain('opacity')
    expect(reduced.transitionProperty).not.toContain('transform')
    expect(reduced.transitionDuration).toContain('0.16s')
    expect(reduced.imageTransform).toBe('none')

    await page.close()
  })
})
