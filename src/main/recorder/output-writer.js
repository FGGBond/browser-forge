// src/main/recorder/output-writer.js
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

export async function writeSession({ outputDir, sessionName, metadata, har, timeline, tabs }) {
  const sessionDir = join(outputDir, sessionName)
  await mkdir(sessionDir, { recursive: true })

  await writeFile(join(sessionDir, 'recording.har'), JSON.stringify(har, null, 2))
  await writeFile(join(sessionDir, 'timeline.json'), JSON.stringify(timeline, null, 2))
  await writeFile(join(sessionDir, 'metadata.json'), JSON.stringify(metadata, null, 2))

  const tabDirs = []
  for (const [targetId, tabData] of Object.entries(tabs)) {
    const safeName = `${targetId}-${sanitizeName(tabData.title ?? 'untitled')}`
    const tabDir = join(sessionDir, 'tabs', safeName)
    await mkdir(join(tabDir, 'screenshots'), { recursive: true })
    await mkdir(join(tabDir, 'scripts'), { recursive: true })

    await writeFile(join(tabDir, 'events.json'), JSON.stringify(tabData.events ?? [], null, 2))
    await writeFile(join(tabDir, 'console.json'), JSON.stringify(tabData.console ?? [], null, 2))

    for (const snap of (tabData.domSnapshots ?? [])) {
      await writeFile(join(tabDir, `dom-${snap.timestamp}.html`), snap.html)
    }

    for (const ss of (tabData.screenshots ?? [])) {
      await writeFile(join(tabDir, 'screenshots', `${ss.timestamp}.png`), Buffer.from(ss.dataBase64, 'base64'))
    }

    for (const script of (tabData.scripts ?? [])) {
      const scriptPath = urlToFilePath(script.url)
      const scriptFile = join(tabDir, 'scripts', scriptPath)
      await mkdir(join(scriptFile, '..'), { recursive: true }).catch(() => {})
      await writeFile(scriptFile, script.content).catch(() => {})
    }

    tabDirs.push(safeName)
  }

  const durationSec = Math.round((metadata.durationMs ?? 0) / 1000)
  const durationStr = `${Math.floor(durationSec / 60)}分${durationSec % 60}秒`
  const harEntryCount = har.log.entries.length

  const recording = [
    '# browser-forge 录制物料',
    '',
    `录制时间：${metadata.startedAt ?? ''}`,
    `起始 URL：${metadata.startUrl}`,
    `时长：${durationStr} | Tab 数量：${metadata.tabs.length} | 网络请求：${harEntryCount}个`,
    '',
    '## 目录结构',
    `${sessionName}/`,
    '├── RECORDING.md',
    '├── recording.har         HAR 1.2 格式，含所有 Tab 的网络请求',
    '├── timeline.json         全局事件时间线',
    '├── metadata.json         录制元数据',
    '└── tabs/',
    ...tabDirs.map((d, i) => `    ${i === tabDirs.length - 1 ? '└' : '├'}── ${d}/`),
    '',
    '## 文件说明',
    '- `recording.har` — 全部网络请求和响应，HAR 1.2 格式，含 headers、body、状态码、时序',
    '- `timeline.json` — 全局事件时间线，包含 Tab 创建/关闭/切换、页面导航、用户交互，按时间戳排列',
    '- `metadata.json` — 录制元数据：起始 URL、录制时长、Chrome 版本、Tab 列表（targetId + 标题 + URL）',
    '- `tabs/{tab}/events.json` — 该 Tab 内的用户交互事件序列（点击、输入、滚动），含目标元素选择器和时间戳',
    '- `tabs/{tab}/dom-{ts}.html` — 该 Tab 在导航完成时的完整 DOM 快照，文件名中的时间戳对应导航事件',
    '- `tabs/{tab}/console.json` — 该 Tab 的 Console 输出，含 log/warn/error 级别和 JS 异常堆栈',
    '- `tabs/{tab}/screenshots/` — 关键事件时刻的截图，文件名为事件触发时的时间戳（ms）',
    '- `tabs/{tab}/scripts/` — 该 Tab 加载的 JS 文件，按原始 URL 路径结构存放，相同内容去重',
  ].join('\n')

  await writeFile(join(sessionDir, 'RECORDING.md'), recording)

  return sessionDir
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9一-龥_-]/g, '_').slice(0, 40)
}

function urlToFilePath(url) {
  try {
    const u = new URL(url)
    return (u.hostname + u.pathname).replace(/[^a-zA-Z0-9./\-_]/g, '_')
  } catch {
    return 'unknown.js'
  }
}
