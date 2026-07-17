// src/renderer/src/views/Done.jsx
export default function Done({ sessionDir, onReset }) {
  function openFolder() {
    window.electronAPI.openFolder(sessionDir)
  }

  function copyPath() {
    navigator.clipboard.writeText(sessionDir)
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 16 }}>录制完成</h2>
      <div style={{ fontSize: 12, color: '#555', background: '#f5f5f5', padding: 10, borderRadius: 4, marginBottom: 20, wordBreak: 'break-all' }}>
        {sessionDir}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={openFolder} style={{ flex: 1, padding: 10, fontSize: 13 }}>在 Finder 中打开</button>
        <button onClick={copyPath} style={{ flex: 1, padding: 10, fontSize: 13 }}>复制路径</button>
      </div>
      <button onClick={onReset} style={{ width: '100%', padding: 10, fontSize: 13, color: '#1a73e8', background: 'none', border: '1px solid #1a73e8', borderRadius: 4, cursor: 'pointer' }}>
        新建录制
      </button>
    </div>
  )
}
