// src/renderer/src/views/Setup.jsx
export default function Setup({ chromePath, setChromePath, outputDir, setOutputDir, onStart }) {
  async function pickChrome() {
    const path = await window.electronAPI.findChromePath()
    setChromePath(path)
  }

  async function pickOutputDir() {
    const dir = await window.electronAPI.pickOutputDir()
    if (dir) setOutputDir(dir)
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 20 }}>browser-forge</h2>

      <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>Chrome 路径</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={chromePath}
          onChange={e => setChromePath(e.target.value)}
          style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}
          placeholder="自动探测..."
        />
        <button onClick={pickChrome} style={{ padding: '6px 12px' }}>探测</button>
      </div>

      <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>录制输出目录</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input
          value={outputDir}
          readOnly
          style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}
          placeholder="选择目录..."
        />
        <button onClick={pickOutputDir} style={{ padding: '6px 12px' }}>选择</button>
      </div>

      <button
        onClick={onStart}
        disabled={!chromePath || !outputDir}
        style={{ width: '100%', padding: '10px', fontSize: 14, background: '#1a73e8', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
      >
        启动 Chrome 并开始录制
      </button>
    </div>
  )
}
